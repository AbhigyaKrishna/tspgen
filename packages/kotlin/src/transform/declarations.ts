import type {
  ApiIR,
  ConstraintsIR,
  CustomScalarIR,
  DecoratorData,
  EnumIR,
  ModelIR,
  PropertyIR,
  ParamIR,
  OperationIR,
  StreamIR,
  TypeIR,
  TypeRef,
  UnionIR,
} from "@abhigyakrishna/tspgen-core";
import {
  declarationScopes,
  metaBoolean,
  metaScopes,
  metaStrings,
  reportDiagnostic as reportCoreDiagnostic,
  resolveMeta,
  type MetaScopes,
  type ResolvedFeatures,
} from "@abhigyakrishna/tspgen-core";
import { NoTarget, type Program } from "@typespec/compiler";
import { qualifyText } from "../imports.js";
import { kotlinString } from "../kotlin-string.js";
import { reportDiagnostic, type EnumMemberNaming } from "../lib.js";
import { camel, identifier, typeName, upperSnake } from "../naming.js";
import { decoratorArg, decoratorArgs } from "./decorators.js";
import { renderDefault } from "./defaults.js";
import { boundChecks } from "./bounds.js";
import { EncodingBuilder } from "./encodings.js";
import type {
  KtDataClass,
  KtDecl,
  KtEnum,
  KtEnumMember,
  KtEvent,
  KtEvents,
  KtProperty,
  KtSealedInterface,
  KtStream,
  KtTypeAlias,
  KtTypeUse,
  KtValueClass,
  ScalarStyle,
} from "./model.js";
import { jsonShape } from "./json-shape.js";
import { mappedPackage } from "./packages.js";
import {
  fqnTypeUse,
  genericOf,
  JSON_ELEMENT,
  listOf,
  mapOf,
  nullable,
  scalarTypeUse,
  serializedIn,
  serializerExpr,
  type DateTimeMapping,
  type DecimalMapping,
} from "./type-map.js";

type UnionShape = "enum" | "string-alias" | "open-enum" | "sealed-interface" | "untagged" | "json";

export interface DeclarationOptions {
  modelsPackage: string;
  dateTime?: DateTimeMapping;
  decimal?: DecimalMapping;
  /** nested: variant models only a sealed union uses are declared inside it. */
  unionVariants?: "nested" | "top-level";
  enumMemberNaming: EnumMemberNaming;
  packages?: Record<string, string>;
  validation?: boolean;
  features?: ResolvedFeatures<string>;
  scalarStyle?: ScalarStyle;
}

const SCALAR_STYLES: readonly ScalarStyle[] = ["inline", "typealias", "value-class"];

function needsGenericCodec(type: KtTypeUse): boolean {
  if (type.generic && serializerExpr(type)) return true;
  return Boolean((type.element && needsGenericCodec(type.element)) || (type.value && needsGenericCodec(type.value)));
}

function items(n: number): string {
  return `${n} ${n === 1 ? "item" : "items"}`;
}

/** Builds Kotlin declarations for every IR type and resolves TypeRefs to Kotlin type uses. */
export class DeclarationBuilder {
  private readonly decls = new Map<string, KtDecl>();
  /** Variant data classes moved inside their sealed union, by IR id. */
  private readonly nested = new Map<string, { parent: KtSealedInterface; decl: KtDataClass }>();
  private readonly mapped = new Map<string, KtTypeUse>();
  /** Template instances mapped with @Kotlin.type: rendered as `<fqn><args>`. */
  private readonly generic = new Map<string, { fqn: string; args: TypeRef[] }>();
  private readonly types: Map<string, TypeIR>;
  /**
   * Per data-class decl id, the source PropertyIR by wire name — recorded in `fillModel` and
   * consulted only after sealed unions have removed discriminator properties, so validation
   * checks are never emitted for properties no longer on the class.
   */
  private readonly modelProps = new Map<string, Map<string, PropertyIR>>();
  /** Ids of multipart models (with parts, or request bodies): plain (non-@Serializable) classes, as they hold files. */
  private readonly multipartModels: Set<string>;
  private usesFile = false;
  private usesSseMessage = false;
  private usesULongAsString = false;
  private usesModelCheck = false;
  private usesPresence = false;
  readonly numberSerializers = new Set<string>();
  readonly encodings: EncodingBuilder;

  get presenceUsed(): boolean { return this.usesPresence; }
  /** Value-class scalars used with a property's own `@encode(string)`: their generated `<Name>AsStringSerializer`. */
  private readonly usedValueClassAsString = new Map<string, { name: string; fqn: string; wraps: "Long" | "ULong" }>();

  constructor(
    private readonly program: Program,
    private readonly api: ApiIR,
    private readonly options: DeclarationOptions,
  ) {
    this.encodings = new EncodingBuilder(options.modelsPackage);
    this.types = new Map(api.types.map((t) => [t.id, t]));
    this.multipartModels = new Set([
      ...api.types.flatMap((t) => (t.kind === "model" && t.multipart ? [t.id] : [])),
      ...api.services.flatMap((s) =>
        s.groups.flatMap((g) =>
          g.operations.flatMap((op) => (op.body?.kind === "multipart" && op.body.type.kind === "named" ? [op.body.type.id] : [])),
        ),
      ),
    ]);
  }

  /** FQN of the generated `HttpFile` class (models package). */
  get httpFileFqn(): string {
    return `${this.options.modelsPackage}.HttpFile`;
  }

  /** Whether any type use so far mapped `Http.File` to `HttpFile`. */
  get fileUsed(): boolean {
    return this.usesFile;
  }

  /** FQN of the generated `SseMessage` class (models package): the element of untyped event streams. */
  get sseMessageFqn(): string {
    return `${this.options.modelsPackage}.SseMessage`;
  }

  /** Whether some operation streams untyped server-sent events (so `SseMessage` is generated). */
  get sseMessageUsed(): boolean {
    return this.usesSseMessage;
  }

  /** FQN of the generated `ModelCheckException` class (models package): what the generated checks throw. */
  get modelCheckExceptionFqn(): string {
    return `${this.options.modelsPackage}.ModelCheckException`;
  }

  /** Whether some generated check (or an @meta check naming it) throws `ModelCheckException`. */
  get modelCheckUsed(): boolean {
    return this.usesModelCheck;
  }

  /** Whether some type use is a string-encoded ULong (ModelSerializers.kt then declares ULongAsStringSerializer). */
  get ulongAsStringUsed(): boolean {
    return this.usesULongAsString;
  }

  /** Value-class scalars whose `<Name>AsStringSerializer` ModelSerializers.kt must declare (see `valueClassAsString`). */
  get valueClassAsStringSerializers(): { name: string; fqn: string; wraps: "Long" | "ULong" }[] {
    return [...this.usedValueClassAsString.values()];
  }

  /** The Kotlin side of a response stream whose body type is `ref`: its events declaration, else `SseMessage`. */
  stream(stream: StreamIR, ref: TypeRef): KtStream {
    const decl = stream.events && ref.kind === "named" ? this.decls.get(ref.id) : undefined;
    if (decl?.kind === "events") return { type: this.typeUse(ref), events: decl };
    this.usesSseMessage = true;
    return { type: { text: "SseMessage", imports: [this.sseMessageFqn], nullable: false } };
  }

  /** Kotlin name of property `name` declared on model `modelId`, as its data class declares it. */
  propertyName(modelId: string, name: string): string {
    const model = this.types.get(modelId);
    const prop = model?.kind === "model" ? model.properties.find((p) => p.name === name) : undefined;
    return prop ? this.kotlinName(prop) : identifier(camel(name));
  }

  private kotlinName(p: PropertyIR): string {
    return identifier(decoratorArg(p.decorators, "Kotlin.name") ?? camel(p.name));
  }

  parameterChecks(parameter: Pick<ParamIR, "name" | "type" | "constraints">, type: KtTypeUse, name: string): string[] {
    const source: PropertyIR = { ...parameter, wireName: parameter.name, optional: false, decorators: {} };
    const property: KtProperty = { name, wireName: parameter.name, type, override: false, annotations: [], meta: {} };
    const checks = this.checks(source, property, parameter.name);
    if (checks.length) this.usesModelCheck = true;
    return checks;
  }

  build(): KtDecl[] {
    for (const t of this.api.types) {
      const fqn = decoratorArg(t.decorators, "Kotlin.type");
      if (!fqn) continue;
      if (t.kind === "model" && t.templateArgs?.length) this.generic.set(t.id, { fqn, args: t.templateArgs });
      else this.mapped.set(t.id, fqnTypeUse(fqn));
    }
    const own = this.api.types.filter((t) => !this.mapped.has(t.id) && !this.generic.has(t.id));
    for (const t of own) this.decls.set(t.id, this.shell(t));
    // User scalars declared as typealiases / value classes, before any type use refers to them.
    for (const scalar of this.api.customScalars) {
      if (decoratorArg(scalar.decorators, "Kotlin.type")) continue;
      const decl = this.scalarDecl(scalar);
      if (decl) this.decls.set(scalar.id, decl);
    }
    // Enums (and enum-like unions) first so model defaults can reference members; sealed unions
    // last so they can adjust their variant data classes.
    for (const t of own) if (t.kind === "enum") this.fillEnum(t);
    for (const t of own) if (t.kind === "union" && this.unionShape(t) !== "sealed-interface") this.fillUnion(t);
    for (const t of own) if (t.kind === "model") this.prepareModel(t);
    for (const t of own) if (t.kind === "model") this.fillModel(t);
    for (const t of own) if (t.kind === "union" && this.unionShape(t) === "sealed-interface") this.fillUnion(t);
    if (this.options.unionVariants !== "top-level") {
      const uses = countNamedUses(this.api);
      for (const t of own) if (t.kind === "union" && this.unionShape(t) === "sealed-interface") this.nestVariants(t, uses);
    }
    this.fillDefaults();
    this.fillChecks();
    this.checkDuplicates();
    return [...this.decls.values()];
  }

  typeUse(ref: TypeRef): KtTypeUse {
    switch (ref.kind) {
      case "named": {
        const generic = this.generic.get(ref.id);
        if (generic) return genericOf(fqnTypeUse(generic.fqn), generic.args.map((arg) => this.typeUse(arg)));
        const base = this.namedTypeUse(ref.id);
        return ref.args?.length && base !== JSON_ELEMENT ? genericOf(base, ref.args.map((arg) => this.typeUse(arg))) : base;
      }
      case "typeParam":
        return { text: ref.name, imports: [], nullable: false };
      case "array":
        return this.encodings.array(listOf(this.typeUse(ref.of)), ref.delimiter);
      case "map":
        return mapOf(this.typeUse(ref.of));
      case "scalar": {
        const fqn = decoratorArg(ref.custom?.decorators, "Kotlin.type");
        if (fqn) return fqnTypeUse(fqn);
        const std = this.stdScalarUse(ref.name);
        const base = this.encodings.typeUse(ref.encoding === "string" ? this.stringEncoded(std) : std, ref.name, ref.wireEncoding);
        const decl = ref.custom ? this.decls.get(ref.custom.id) : undefined;
        if (decl?.kind === "typealias") {
          const needs = serializedIn(base);
          return { ...base, text: decl.name, imports: [decl.fqn], underlying: base, ...(needs.length ? { needs } : {}) };
        }
        if (decl?.kind === "value-class") {
          // A value class has one wire encoding, fixed by the scalar's own @encode (`stringEncoded` above, on
          // `decl.value`). A use's own @encode(string) then wraps it in a generated `<Name>AsStringSerializer` —
          // same class, same wire, just annotated at this use (see `valueClassAsString`).
          if (ref.encoding === "string" && !decl.value.serializer) {
            const wrapped = this.valueClassAsString(decl);
            if (wrapped) return wrapped;
          }
          const wrapped: KtTypeUse = { text: decl.name, imports: [decl.fqn], nullable: false, underlying: base, wrapper: "value-class" };
          return base.serializer !== decl.value.serializer ? this.encodings.wrap(wrapped, base) : wrapped;
        }
        return base;
      }
      case "literal":
        if (ref.value === null) return { text: "JsonNull", imports: ["kotlinx.serialization.json.JsonNull"], nullable: false };
        return this.literalType(ref);
      case "nullable":
        return nullable(this.typeUse(ref.of));
      case "file":
        this.usesFile = true;
        return { text: "HttpFile", imports: [this.httpFileFqn], nullable: false, file: true };
      case "unknown":
        return JSON_ELEMENT;
    }
  }

  /** A std scalar's type use; a java.time / java.math class is written qualified when a generated type takes its name. */
  private literalType(ref: Extract<TypeRef, { kind: "literal" }>): KtTypeUse {
    if (typeof ref.value === "string") return scalarTypeUse("string");
    if (typeof ref.value === "boolean") return scalarTypeUse("boolean");
    if (ref.numericText && !/^-?\d+$/.test(ref.numericText)) return this.exactNumberUse("numeric");
    const value = ref.numericText ? BigInt(ref.numericText) : undefined;
    if (value !== undefined && (value < -(1n << 63n) || value >= (1n << 63n))) return this.exactNumberUse("integer");
    if (typeof ref.value === "number" && Number.isInteger(ref.value)) {
      return scalarTypeUse(ref.value >= -2147483648 && ref.value <= 2147483647 ? "int32" : "int64");
    }
    return scalarTypeUse("float64");
  }

  private stdScalarUse(name: string): KtTypeUse {
    if (this.options.features?.values["precise-numbers"] && (name === "decimal" || name === "decimal128")) {
      if (this.options.decimal === "string") {
        this.numberSerializers.add("DecimalTextSerializer");
        return { text: "String", imports: [], nullable: false, serializer: "DecimalTextSerializer",
          serialImports: ["kotlinx.serialization.Serializable", `${this.options.modelsPackage}.DecimalTextSerializer`] };
      }
      return this.exactNumberUse("numeric");
    }
    if (this.options.features?.values["precise-numbers"] && (name === "integer" || name === "numeric")) {
      return this.exactNumberUse(name);
    }
    const scalar = scalarTypeUse(name, this.options.dateTime, this.options.decimal);
    const [fqn] = scalar.imports.filter((i) => i.startsWith("java.time.") || i.startsWith("java.math."));
    return fqn && this.hasName(scalar.text) ? { text: fqn, imports: [], nullable: false } : scalar;
  }

  private exactNumberUse(name: "integer" | "numeric"): KtTypeUse {
    const type = name === "integer" ? "BigInteger" : "BigDecimal";
    const serializer = name === "integer" ? "BigIntegerSerializer" : "NumericSerializer";
    this.numberSerializers.add(serializer);
    return { text: this.hasName(type) ? `java.math.${type}` : type, imports: [`java.math.${type}`], nullable: false,
      serializer, serialImports: [`${this.options.modelsPackage}.${serializer}`, "kotlinx.serialization.Serializable"] };
  }

  /**
   * `@encode(string)`: Long (int64, integer, safeint) with kotlinx's LongAsStringSerializer, ULong with the generated
   * ULongAsStringSerializer. Exact decimal codecs preserve the explicit string wire kind.
   */
  private stringEncoded(type: KtTypeUse): KtTypeUse {
    if (type.serializer === "DecimalTextSerializer") {
      this.numberSerializers.add("DecimalTextAsStringSerializer");
      return { ...type, serializer: "DecimalTextAsStringSerializer", serialImports: [
        "kotlinx.serialization.Serializable", `${this.options.modelsPackage}.DecimalTextAsStringSerializer`,
      ] };
    }
    if (type.serializer === "NumericSerializer") {
      this.numberSerializers.add("BigDecimalAsStringSerializer");
      return { ...type, serializer: "BigDecimalAsStringSerializer", serialImports: [
        "kotlinx.serialization.Serializable", `${this.options.modelsPackage}.BigDecimalAsStringSerializer`,
      ] };
    }
    if (type.text === "BigInteger" || type.text === "java.math.BigInteger") {
      this.numberSerializers.add("BigIntegerAsStringSerializer");
      return { ...type, serializer: "BigIntegerAsStringSerializer", serialImports: [
        "kotlinx.serialization.Serializable", `${this.options.modelsPackage}.BigIntegerAsStringSerializer`,
      ] };
    }
    if (type.text === "Long") {
      return {
        ...type,
        serializer: "LongAsStringSerializer",
        serialImports: ["kotlinx.serialization.Serializable", "kotlinx.serialization.builtins.LongAsStringSerializer"],
      };
    }
    if (type.text === "ULong") {
      this.usesULongAsString = true;
      return {
        ...type,
        serializer: "ULongAsStringSerializer",
        serialImports: ["kotlinx.serialization.Serializable", `${this.options.modelsPackage}.ULongAsStringSerializer`],
      };
    }
    return type;
  }

  /**
   * `scalar-style: value-class`, a use's own `@encode(string)` (the scalar itself is not already string-encoded):
   * `<Name>AsStringSerializer`, generated once per scalar in ModelSerializers.kt, wraps `LongAsStringSerializer` /
   * the generated `ULongAsStringSerializer` around `decl.value` — `Long`/`ULong` only, since decimal-based value
   * classes (`String`/`BigDecimal`) already write a JSON string and need no serializer at the use site.
   */
  private valueClassAsString(decl: KtValueClass): KtTypeUse | undefined {
    const wraps = decl.value.text === "Long" ? "Long" : decl.value.text === "ULong" ? "ULong" : undefined;
    if (!wraps) return undefined;
    const serializerName = `${decl.name}AsStringSerializer`;
    if (!this.usedValueClassAsString.has(decl.id)) {
      this.usedValueClassAsString.set(decl.id, { name: serializerName, fqn: decl.fqn, wraps });
      if (wraps === "ULong") this.usesULongAsString = true;
    }
    return {
      text: decl.name,
      imports: [decl.fqn],
      nullable: false,
      underlying: decl.value,
      wrapper: "value-class",
      serializer: serializerName,
      serialImports: ["kotlinx.serialization.Serializable", `${this.options.modelsPackage}.${serializerName}`],
    };
  }

  /** A named type without its type arguments: mapped, nested in a sealed union, or its own declaration. */
  private namedTypeUse(id: string): KtTypeUse {
    const mapped = this.mapped.get(id);
    if (mapped) return mapped;
    const nested = this.nested.get(id);
    if (nested) return { text: `${nested.parent.name}.${nested.decl.name}`, imports: [nested.parent.fqn], nullable: false, structuredParam: true };
    const decl = this.decls.get(id);
    if (!decl) return JSON_ELEMENT;
    return {
      text: decl.name, imports: [decl.fqn], nullable: false,
      ...(["data-class", "sealed-interface", "untagged-union"].includes(decl.kind) ? { structuredParam: true } : {}),
      ...(decl.kind === "enum" && decl.jsonValues ? { enumWire: true } : {}),
      ...(decl.kind === "value-class" && decl.constants ? { underlying: decl.value, wrapper: "value-class" as const } : {}),
    };
  }

  /** True if a model-level declaration already uses this simple name. */
  hasName(name: string): boolean {
    return [...this.decls.values()].some((d) => d.name === name);
  }

  /** Annotation lines: @Deprecated, @Kotlin.annotate and `annotations` from kotlin-scoped @meta. */
  annotations(
    item: { decorators: DecoratorData; deprecated?: string },
    where: string,
    scopes: MetaScopes = metaScopes(item.decorators),
  ): string[] {
    const list: string[] = [];
    if (item.deprecated !== undefined) list.push(`@Deprecated(${kotlinString(item.deprecated)})`);
    list.push(...decoratorArgs(item.decorators, "Kotlin.annotate"));
    list.push(...metaStrings(this.program, resolveMeta(scopes, "kotlin"), "annotations", where));
    // Merged scopes concatenate arrays, so an annotation inherited from several levels repeats.
    return [...new Set(list)];
  }

  operationDocs(operation: OperationIR, scopes: MetaScopes): string | undefined {
    if (this.options.features && !this.options.features.at("docs", resolveMeta(scopes, "kotlin"), "operation")) return undefined;
    const parameters = operation.params.flatMap((parameter) => {
      const text = [parameter.docs, parameter.deprecated !== undefined ? `Deprecated: ${parameter.deprecated}` : undefined].filter(Boolean).join(" ");
      return text ? [`@param ${identifier(camel(parameter.name))} ${text}`] : [];
    });
    if (operation.body) {
      const text = [operation.body.docs, operation.body.deprecated !== undefined ? `Deprecated: ${operation.body.deprecated}` : undefined].filter(Boolean).join(" ");
      if (text) parameters.push(`@param ${identifier(camel(operation.body.name ?? "body"))} ${text}`);
    }
    return [operation.docs, ...parameters].filter(Boolean).join("\n") || undefined;
  }

  private shell(t: TypeIR): KtDecl {
    const name = decoratorArg(t.decorators, "Kotlin.name") ?? typeName(t.name);
    const pkg =
      decoratorArg(t.decorators, "Kotlin.packageName") ??
      mappedPackage(this.options.packages, t.namespace) ??
      this.options.modelsPackage;
    const scopes = metaScopes(t.decorators);
    const meta = resolveMeta(scopes, "kotlin");
    const implementsMeta = metaStrings(this.program, meta, "implements", t.id);
    const base = {
      id: t.id,
      name,
      package: pkg,
      fqn: `${pkg}.${name}`,
      ...(t.docs ? { docs: t.docs } : {}),
      annotations: this.annotations(t, t.id, scopes),
      meta: scopes,
      imports: metaStrings(this.program, meta, "imports", t.id),
    };
    switch (t.kind) {
      case "model":
        return t.discriminator
          ? { ...base, kind: "sealed-interface", discriminator: t.discriminator.property, properties: [], implements: [...implementsMeta], variants: [] }
          : {
              ...base,
              kind: "data-class",
              properties: [],
              implements: [...implementsMeta],
              checks: [],
              ...(this.multipartModels.has(t.id) ? { plain: true } : {}),
              ...(t.typeParameters?.length ? { typeParameters: t.typeParameters } : {}),
            };
      case "enum":
        return t.members.every((m) => typeof m.value === "string") || this.options.features?.values["numeric-enums"]
          ? { ...base, kind: "enum", members: [] }
          : { ...base, kind: "typealias", target: JSON_ELEMENT };
      case "union":
        if (t.events) return { ...base, kind: "events", events: [] };
        switch (this.unionShape(t)) {
          case "enum":
            return { ...base, kind: "enum", members: [] };
          case "sealed-interface":
            return { ...base, kind: "sealed-interface", discriminator: t.discriminator!.property, properties: [], implements: [...implementsMeta], variants: [] };
          case "untagged":
            return { ...base, kind: "untagged-union", variants: [] };
          case "open-enum":
            return { ...base, kind: "value-class", value: scalarTypeUse("string"), checks: [], constants: [] };
          default:
            return { ...base, kind: "typealias", target: JSON_ELEMENT };
        }
    }
  }

  /** A user scalar's style: its `scalarStyle` meta when valid (else invalid-meta), otherwise the option. */
  private scalarStyle(s: CustomScalarIR): ScalarStyle {
    const fallback = this.options.scalarStyle ?? "inline";
    const value = resolveMeta(metaScopes(s.decorators), "kotlin").scalarStyle;
    if (value === undefined) return fallback;
    const style = SCALAR_STYLES.find((x) => x === value);
    if (style) return style;
    reportCoreDiagnostic(this.program, {
      code: "invalid-meta",
      format: { key: "scalarStyle", where: s.id, expected: 'one of "inline", "typealias", "value-class"' },
      target: NoTarget,
    });
    return fallback;
  }

  /** The typealias / value class of a user scalar; undefined when inlined. */
  private scalarDecl(s: CustomScalarIR): KtTypeAlias | KtValueClass | undefined {
    const style = this.scalarStyle(s);
    if (style === "inline") return undefined;
    const name = decoratorArg(s.decorators, "Kotlin.name") ?? typeName(s.name);
    const pkg =
      decoratorArg(s.decorators, "Kotlin.packageName") ??
      mappedPackage(this.options.packages, s.namespace) ??
      this.options.modelsPackage;
    const scopes = metaScopes(s.decorators);
    const std = this.stdScalarUse(s.root);
    const value = this.encodings.typeUse(s.encoding === "string" ? this.stringEncoded(std) : std, s.root, s.wireEncoding);
    const base = {
      id: s.id,
      name,
      package: pkg,
      fqn: `${pkg}.${name}`,
      ...(s.docs && this.options.features?.values.docs !== false ? { docs: s.docs } : {}),
      annotations: this.annotations(s, s.id, scopes),
      meta: scopes,
      imports: metaStrings(this.program, resolveMeta(scopes, "kotlin"), "imports", s.id),
    };
    if (style === "typealias") return { ...base, kind: "typealias", target: value };
    const c = this.options.validation ? s.constraints : undefined;
    const checks = c ? this.constraintChecks("value", name, c, value, false) : [];
    this.throwsModelCheck(base, checks);
    return { ...base, kind: "value-class", value, checks };
  }

  private unionShape(u: UnionIR): UnionShape {
    const types = u.variants.map((v) => v.type);
    const stringLiterals = types.filter((t) => t.kind === "literal" && typeof t.value === "string").length;
    if (stringLiterals === types.length) return "enum";
    const strings = types.filter((t) => t.kind === "scalar" && t.name === "string").length;
    if (stringLiterals > 0 && stringLiterals + strings === types.length) {
      return this.options.features?.values["open-enums"] ? "open-enum" : "string-alias";
    }
    if (
      u.discriminator?.envelope === "none" &&
      types.every((t) => {
        const model = t.kind === "named" && !t.args?.length ? this.types.get(t.id) : undefined;
        return model?.kind === "model" && !model.typeParameters?.length;
      })
    ) {
      return "sealed-interface";
    }
    return u.jsonLines || u.discriminator?.envelope === "object" || this.options.features?.values["untagged-unions"] ? "untagged" : "json";
  }

  private memberName(name: string): string {
    return this.options.enumMemberNaming === "PascalCase" ? typeName(name) : upperSnake(name);
  }

  private fillEnum(e: EnumIR): void {
    const decl = this.decls.get(e.id)!;
    if (decl.kind === "enum") {
      decl.jsonValues = e.members.some((member) => typeof member.value === "number") || undefined;
      if (decl.jsonValues) decl.serializerName = "Serializer";
      decl.members = e.members.map(
        (m): KtEnumMember => ({
          name: identifier(decoratorArg(m.decorators, "Kotlin.name") ?? this.memberName(m.name)),
          serialName: String(m.value),
          value: m.value,
          ...(m.numericText ? { numericText: m.numericText } : {}),
          ...(m.docs ? { docs: m.docs } : {}),
          annotations: this.annotations(m, `${e.id}.${m.name}`),
          meta: metaScopes(m.decorators),
        }),
      );
      this.fillUnknown(decl, e);
      if (decl.jsonValues && !decl.unknown) {
        while (decl.members.some((member) => member.name === decl.serializerName)) decl.serializerName += "_";
      }
      return;
    }
    if (decl.kind === "typealias") {
      const integers = e.members.every((m) => Number.isInteger(m.value));
      decl.target = scalarTypeUse(integers ? "int32" : "float64");
      reportDiagnostic(this.program, { code: "numeric-enum", format: { id: e.id, type: decl.target.text }, target: NoTarget });
    }
  }

  private fillUnion(u: UnionIR): void {
    const decl = this.decls.get(u.id)!;
    if (decl.kind === "events") {
      this.fillEvents(u, decl);
      return;
    }
    const shape = this.unionShape(u);
    if (decl.kind === "value-class" && shape === "open-enum") {
      decl.constants = u.variants.flatMap((variant) => variant.type.kind === "literal" && typeof variant.type.value === "string"
        ? [{ name: identifier(this.memberName(variant.name ?? variant.type.value)), value: variant.type.value,
          ...(variant.docs ? { docs: variant.docs } : {}),
          annotations: this.annotations({ ...variant, decorators: variant.decorators ?? {} }, `${u.id}.${variant.name ?? variant.type.value}`) }]
        : []);
      return;
    }
    if (decl.kind === "untagged-union") {
      const names = new Set(["Serializer"]);
      decl.variants = u.variants.map((v, index) => {
        const base = typeName(v.name ?? (v.type.kind === "named" ? this.types.get(v.type.id)?.name : undefined) ?? `Variant${index + 1}`);
        let name = base;
        for (let suffix = 2; names.has(name); suffix++) name = `${base}${suffix}`;
        names.add(name);
        return { name, type: this.typeUse(v.type), guard: jsonShape(v.type, this.types),
          ...(v.docs ? { docs: v.docs } : {}), annotations: this.annotations({ ...v, decorators: v.decorators ?? {} }, `${u.id}.${v.name ?? index}`),
          ...(v.type.kind === "literal" ? { literal: v.type.numericText ?? JSON.stringify(v.type.value) } : {}) };
      });
      const nested = new Set(["Serializer", ...decl.variants.map((v) => v.name)]);
      for (const variant of decl.variants) {
        const collisions = variant.type.imports.filter((fqn) => nested.has(fqn.slice(fqn.lastIndexOf(".") + 1)));
        variant.type = { ...variant.type, text: qualifyText(variant.type.text, collisions),
          ...(variant.type.serialText ? { serialText: qualifyText(variant.type.serialText, collisions) } : {}) };
      }
      if (u.discriminator?.envelope === "object") {
        decl.discriminator = { property: u.discriminator.property, envelopeProperty: u.discriminator.envelopeProperty };
        decl.variants.forEach((variant, index) => {
          variant.guard = kotlinString(u.variants[index].name ?? String(index));
        });
      }
      return;
    }
    if (decl.kind === "enum") {
      decl.members = u.variants.map((v) => {
        const value = v.type.kind === "literal" ? String(v.type.value) : "";
        return {
          name: identifier(this.memberName(v.name ?? value)),
          serialName: value,
          ...(v.docs ? { docs: v.docs } : {}),
          annotations: this.annotations({ ...v, decorators: v.decorators ?? {} }, `${u.id}.${v.name ?? value}`),
          meta: {},
        };
      });
      this.fillUnknown(decl, u);
    } else if (decl.kind === "sealed-interface") {
      const variantDocs = u.variants.flatMap((variant, index) => {
        const text = [variant.docs, variant.deprecated !== undefined ? `Deprecated: ${variant.deprecated}` : undefined].filter(Boolean).join(" ");
        return text ? [`${variant.name ?? `Variant ${index + 1}`}: ${text}`] : [];
      });
      const docsEnabled = this.options.features?.at("docs", resolveMeta(metaScopes(u.decorators), "kotlin"), "union") !== false;
      if (docsEnabled && variantDocs.length) decl.docs = [decl.docs, ...variantDocs].filter(Boolean).join("\n\n");
      for (const variant of u.variants) {
        if (variant.type.kind !== "named") continue;
        const target = this.decls.get(variant.type.id);
        if (target?.kind !== "data-class") continue;
        target.implements.push(decl.fqn);
        if (target.serialName === undefined && variant.name) target.serialName = variant.name;
        target.properties = target.properties.filter((p) => p.wireName !== decl.discriminator);
        target.discriminator = decl.discriminator;
      }
    } else if (decl.kind === "typealias") {
      if (shape === "string-alias") {
        decl.target = scalarTypeUse("string");
      } else {
        decl.target = JSON_ELEMENT;
        reportDiagnostic(this.program, { code: "unsupported-union", format: { id: u.id }, target: NoTarget });
      }
    }
  }

  /** `features.enum-unknown`: the fallback member (`UNKNOWN` / `Unknown`; `_` appended when a member has that name). */
  private fillUnknown(decl: KtEnum, source: EnumIR | UnionIR): void {
    const meta = resolveMeta(declarationScopes(source.decorators, source.namespaceDecorators), "kotlin");
    if (!this.options.features?.at("enum-unknown", meta, source.kind)) return;
    const taken = (name: string) => decl.members.some((m) => m.name === name);
    const freeName = (base: string): string => {
      let name = base;
      while (taken(name)) name += "_";
      return name;
    };
    const unknownBase = this.options.enumMemberNaming === "PascalCase" ? "Unknown" : "UNKNOWN";
    decl.unknown = freeName(unknownBase);
    // The nested `Serializer` object shares the class's namespace with the members; a member named `Serializer`
    // (any naming convention) would otherwise redeclare it.
    let serializerName = "Serializer";
    while (taken(serializerName) || serializerName === decl.unknown) serializerName += "_";
    decl.serializerName = serializerName;
  }

  /**
   * One nested class per event, named after the variant (an unnamed one after its literal payload, else its event
   * name). A nested class shadows same-named types inside the interface, so names the payload types use (and the
   * interface's own) get an `Event` suffix.
   */
  private fillEvents(u: UnionIR, decl: KtEvents): void {
    const events = u.events ?? [];
    const payloads = events.map((e) => (e.payload.kind === "literal" ? undefined : this.typeUse(e.payload)));
    const referenced = new Set([decl.name, ...payloads.flatMap((p) => (p ? identifiers(p.text) : []))]);
    const taken = new Set<string>();
    decl.events = events.map((e, i): KtEvent => {
      const variant = u.variants[i]?.name;
      const literal = e.payload.kind === "literal" ? e.payload.value : undefined;
      const label = variant ?? (literal !== undefined && /[A-Za-z]/.test(String(literal)) ? String(literal) : e.name);
      const base = typeName(label.replace(/[^A-Za-z0-9]+/g, " ").trim());
      let name = base;
      for (let n = 1; referenced.has(name) || taken.has(name); n++) name = `${base}Event${n > 1 ? n : ""}`;
      taken.add(name);
      const json = /[/+]json(;|$)/.test(e.contentType);
      const source = u.variants[i];
      const annotations = source ? this.annotations({ ...source, decorators: source.decorators ?? {} }, `${u.id}.${source.name ?? i}`) : [];
      return {
        ...(annotations.length ? { annotations } : {}),
        name,
        event: e.name,
        ...(literal !== undefined ? { literal: json ? JSON.stringify(literal) : String(literal) } : { data: payloads[i]! }),
        json,
        terminal: e.terminal,
        ...(e.docs ? { docs: e.docs } : {}),
      };
    });
  }

  /**
   * Moves the variants of a sealed union that nothing else references inside it, named after their
   * variant key (`catalog` → `Catalog`) unless @Kotlin.name renames the model.
   */
  private nestVariants(u: UnionIR, uses: Map<string, number>): void {
    const parent = this.decls.get(u.id);
    if (parent?.kind !== "sealed-interface") return;
    const candidates = u.variants.flatMap((variant) => {
      if (variant.type.kind !== "named" || uses.get(variant.type.id) !== 1) return [];
      const decl = this.decls.get(variant.type.id);
      const source = this.types.get(variant.type.id);
      if (decl?.kind !== "data-class" || source?.kind !== "model") return [];
      // Kotlin requires sealed inheritors in the sealed type's package: nesting must not move a variant
      // away from a @discriminator base it extends.
      const sealedBases = this.chain(source)
        .slice(0, -1)
        .map((m) => this.decls.get(m.id))
        .filter((d) => d?.kind === "sealed-interface");
      if (sealedBases.some((d) => d!.package !== parent.package)) return [];
      return [{ variant, id: variant.type.id, decl, source }];
    });
    // Inside the interface a nested class shadows any type of the same simple name, so a nested name must
    // not be one the interface or its variants refer to (`catalog: CatalogSource { catalog: Catalog }`),
    // the interface's own name, or a sibling's.
    const referenced = new Set([
      parent.name,
      ...[parent, ...candidates.map((c) => c.decl)].flatMap((d) => d.properties.flatMap((p) => identifiers(p.type.text))),
    ]);
    const taken = new Set<string>();
    for (const { variant, id, decl, source } of candidates) {
      const preferred = decoratorArg(source.decorators, "Kotlin.name") ?? (variant.name ? typeName(variant.name) : decl.name);
      const name = [preferred, decl.name].find((n) => !referenced.has(n) && !taken.has(n));
      if (!name) continue;
      taken.add(name);
      const nestedId = id;
      decl.name = name;
      decl.package = parent.package;
      decl.fqn = `${parent.fqn}.${name}`;
      this.decls.delete(nestedId);
      this.nested.set(nestedId, { parent, decl });
      parent.variants.push(decl);
    }
  }

  private fillModel(model: ModelIR): void {
    const decl = this.decls.get(model.id)!;
    if (decl.kind === "sealed-interface") {
      decl.properties = model.properties
        .filter((p) => p.name !== model.discriminator?.property)
        .map((p) => this.property(p, false, model.id));
      return;
    }
    if (decl.kind !== "data-class") return;
    const chain = this.chain(model);
    const discriminators = new Set(chain.flatMap((m) => (m.discriminator ? [m.discriminator.property] : [])));
    const sealedBases = chain.slice(0, -1).filter((m) => m.discriminator && this.decls.get(m.id)?.kind === "sealed-interface");
    const abstractNames = new Set(sealedBases.flatMap((m) => m.properties.map((p) => p.name)));
    const byName = new Map<string, PropertyIR>();
    for (const m of chain) for (const p of m.properties) if (!discriminators.has(p.name)) byName.set(p.name, p);
    const props = [...byName.values()];
    decl.properties = props.map((p) => this.property(p, abstractNames.has(p.name), model.id));
    if (decl.properties.some((property) => {
      const type = property.presence ?? property.type;
      return needsGenericCodec(type);
    })) decl.jsonCodec = true;
    this.modelProps.set(model.id, new Map(props.map((p) => [p.wireName, p])));
    this.fillSealedParents(model, decl, sealedBases);
  }

  private prepareModel(model: ModelIR): void {
    const declaration = this.decls.get(model.id);
    if (declaration?.kind !== "data-class") return;
    const chain = this.chain(model);
    const additional = chain.findLast((item) => item.additionalProperties)?.additionalProperties;
    if (additional) {
      const names = new Set(chain.flatMap((item) => item.properties.map((property) => this.kotlinName(property).replace(/`/g, ""))));
      let name = "additionalProperties";
      while (names.has(name)) name += "_";
      declaration.additional = { name, type: mapOf(this.typeUse(additional)) };
    }
    if (model.tuple) declaration.tuple = true;
  }

  /** Defaults name final constructors, after sealed variants have acquired their nested names. */
  private fillDefaults(): void {
    for (const [id, properties] of this.modelProps) {
      const declaration = this.decls.get(id) ?? this.nested.get(id)?.decl;
      if (declaration?.kind !== "data-class") continue;
      declaration.properties = declaration.properties.map((property) => {
        const source = properties.get(property.wireName);
        return source?.default === undefined ? property : this.property(source, property.override, id);
      });
    }
  }

  /**
   * Fills `checks` on every data class, after sealed unions have removed discriminator
   * properties (`fillUnion` runs after `fillModel` for sealed interfaces) — so a check for a
   * property no longer on the class is never emitted. Property order first, then @meta lines.
   */
  private fillChecks(): void {
    for (const [id, byWireName] of this.modelProps) {
      const decl = this.decls.get(id) ?? this.nested.get(id)?.decl;
      if (decl?.kind !== "data-class") continue;
      const generated = decl.properties.flatMap((prop) => {
        const p = byWireName.get(prop.wireName);
        return p ? this.checks(p, prop, `${id}.${p.name}`) : [];
      });
      if (decl.additional && this.options.validation !== false) {
        const model = this.types.get(id);
        const ref = model?.kind === "model" ? this.chain(model).findLast((item) => item.additionalProperties)?.additionalProperties : undefined;
        if (ref) generated.push(...this.collectionChecks({ kind: "map", of: ref }, decl.additional.type, decl.additional.name, decl.additional.name));
      }
      const meta = metaStrings(this.program, resolveMeta(decl.meta, "kotlin"), "checks", id);
      this.throwsModelCheck(decl, [...generated, ...meta.filter((line) => /\bModelCheckException\b/.test(line))]);
      decl.checks = [...generated, ...meta];
    }
  }

  /** Records that `decl`'s `checks` (generated ones, or @meta ones naming it) throw `ModelCheckException`. */
  private throwsModelCheck(decl: { imports: string[] }, checks: readonly string[]): void {
    if (checks.length === 0) return;
    this.usesModelCheck = true;
    decl.imports.push(this.modelCheckExceptionFqn);
  }

  private fillSealedParents(model: ModelIR, decl: KtDataClass, sealedBases: ModelIR[]): void {
    for (const base of sealedBases) {
      decl.implements.push(this.decls.get(base.id)!.fqn);
      const value = Object.entries(base.discriminator!.mapping).find(([, id]) => id === model.id)?.[0];
      if (value !== undefined) decl.serialName = value;
      decl.discriminator = base.discriminator!.property;
    }
  }

  private chain(model: ModelIR): ModelIR[] {
    const chain: ModelIR[] = [];
    let current: ModelIR | undefined = model;
    while (current) {
      chain.unshift(current);
      const base: TypeIR | undefined = current.baseId ? this.types.get(current.baseId) : undefined;
      current = base?.kind === "model" ? base : undefined;
    }
    return chain;
  }

  private property(p: PropertyIR, override: boolean, owner: string): KtProperty {
    const name = this.kotlinName(p);
    const fqn = decoratorArg(p.decorators, "Kotlin.type");
    let type = fqn ? fqnTypeUse(fqn) : this.typeUse(p.type);
    const defaultValue = p.default !== undefined ? this.defaultLiteral(p.default, p.type, type) : undefined;
    if (p.optional && defaultValue === undefined) type = nullable(type);
    const prop: KtProperty = {
      name,
      wireName: p.wireName,
      type,
      override,
      ...(p.docs ? { docs: p.docs } : {}),
      annotations: this.annotations(p, `${owner}.${p.name}`),
      meta: metaScopes(p.decorators),
    };
    if (name.replace(/`/g, "") !== p.wireName && !this.multipartModels.has(owner)) prop.serialName = p.wireName;
    // Multipart request classes are not @Serializable: no serializer annotations there.
    if (!this.multipartModels.has(owner)) {
      if (type.serializer) prop.annotations = [`@Serializable(with = ${type.serializer}::class)`, ...prop.annotations];
      if (type.serialText) prop.serialType = type.serialText;
      if (type.serialImports?.length) prop.serialImports = type.serialImports;
    }
    if (defaultValue !== undefined) {
      prop.default = defaultValue;
      if (!p.optional && !this.multipartModels.has(owner)) prop.encodeDefault = true;
    } else if (p.optional) prop.default = "null";
    const presence = this.options.features?.values["strict-optionals"] ||
      p.type.kind === "nullable" && this.options.features?.values["optional-presence"];
    if (p.optional && !this.multipartModels.has(owner) && presence) {
      this.usesPresence = true;
      const present = fqn ? fqnTypeUse(fqn) : this.typeUse(p.type);
      prop.presence = present;
      const inner = present.serialText ?? (present.serializer ? `@Serializable(with = ${present.serializer}::class) ${present.text}` : present.text);
      prop.annotations = prop.annotations.filter((a) => a !== `@Serializable(with = ${type.serializer}::class)`);
      prop.serialType = `OptionalValue<${inner}>`;
      prop.type = { text: `OptionalValue<${present.text}>`, imports: [...present.imports, `${this.options.modelsPackage}.OptionalValue`], nullable: false };
      prop.default = "OptionalValue.Absent";
      prop.annotations.push("@EncodeDefault(EncodeDefault.Mode.NEVER)");
    }
    return prop;
  }

  /**
   * Check lines (throwing `ModelCheckException`) for a property: its constraint decorators when `validation` is on, and the
   * `notBlank` meta flag (an explicit request, so emitted regardless of `validation`). Typealias scalars are checked
   * as their base type; value-class scalars through `.value`, minus the constraints the class checks itself.
   */
  private checks(p: PropertyIR, prop: KtProperty, where: string): string[] {
    if (prop.presence) {
      const inner = this.checks(p, { ...prop, presence: undefined, name: `${prop.name}.value`, type: prop.presence }, where);
      return inner.length ? [`if (${prop.name} is OptionalValue.Present) {`, ...inner.map((line) => `    ${line}`), "}"] : [];
    }
    const notBlank = metaBoolean(this.program, resolveMeta(prop.meta, "kotlin"), "notBlank", where) === true;
    let c = this.options.validation ? p.constraints : undefined;
    let expr = prop.name;
    let type = prop.type;
    if (type.underlying) {
      if (type.wrapper === "value-class") {
        c = c && withoutScalarConstraints(c, p.type);
        expr = `${prop.name}.value`;
      }
      type = { ...type.underlying, nullable: type.nullable };
    }
    const checks = this.constraintChecks(expr, p.name, c, type, notBlank, prop.name);
    if (this.options.validation !== false) {
      checks.push(...this.literalChecks(p.type, prop.name, type.nullable));
      checks.push(...this.collectionChecks(p.type, prop.type, prop.name, p.name));
    }
    return checks;
  }

  private literalChecks(ref: TypeRef, expression: string, nullableValue: boolean): string[] {
    if (ref.kind === "nullable") return this.literalChecks(ref.of, expression, true);
    if (ref.kind !== "literal" || ref.value === null) return [];
    const literal = this.defaultLiteral(ref.numericText ?? ref.value, ref, this.typeUse(ref));
    if (literal === undefined) return [];
    const condition = `${nullableValue ? `${expression} == null || ` : ""}${expression} == ${literal}`;
    return [`if (!(${condition})) throw ModelCheckException(${kotlinString(`${expression} must equal ${String(ref.value)}`)})`];
  }

  private collectionChecks(ref: TypeRef, type: KtTypeUse, expression: string, label: string, depth = 0): string[] {
    if (ref.kind === "nullable") return this.collectionChecks(ref.of, type, expression, label, depth);
    if (ref.kind !== "array" && ref.kind !== "map") return [];
    const element = ref.of;
    const itemType = ref.kind === "array" ? type.element : type.value;
    if (!itemType) return [];
    const item = `item${depth}`;
    const scalar = element.kind === "nullable" ? element.of : element;
    const constraints = scalar.kind === "scalar" && itemType.wrapper !== "value-class" ? scalar.custom?.constraints : undefined;
    const underlying = itemType.underlying;
    const value = itemType.wrapper === "value-class" ? `${item}.value` : item;
    const checks = this.constraintChecks(value, `${label} item`, constraints, underlying ? { ...underlying, nullable: itemType.nullable } : itemType, false, item);
    checks.push(...this.literalChecks(element, item, itemType.nullable));
    checks.push(...this.collectionChecks(element, itemType, item, label, depth + 1));
    if (!checks.length) return [];
    const values = ref.kind === "map" ? `${expression}${type.nullable ? "?" : ""}.values` : expression;
    return [`${values}${type.nullable ? "?" : ""}.forEach { ${item} ->`, ...checks.map((check) => `    ${check}`), "}"];
  }

  /** Lines checking `c` (and `notBlank`) on `expr` of `type`; `guard` is null-checked first when nullable. */
  private constraintChecks(
    expr: string,
    label: string,
    c: ConstraintsIR | undefined,
    type: KtTypeUse,
    notBlank: boolean,
    guard = expr,
  ): string[] {
    if (!c && !notBlank) return [];
    const name = expr;
    const base = type.text.replace(/\?$/, "");
    const out: string[] = [];
    const add = (condition: string, message: string) => {
      const guarded = type.nullable ? `${guard} == null || ${condition}` : condition;
      out.push(`if (!(${guarded})) throw ModelCheckException(${kotlinString(message)})`);
    };
    if (notBlank && base === "String") add(`${name}.isNotBlank()`, `${label} must not be blank`);
    if (!c) return out;
    if (base === "String") {
      // isNotBlank() already rules out the empty string.
      if (c.minLength === 1) {
        if (!notBlank) add(`${name}.isNotEmpty()`, `${label} must not be empty`);
      } else if (c.minLength !== undefined) {
        add(`${name}.length >= ${c.minLength}`, `${label} must be at least ${c.minLength} characters`);
      }
      if (c.maxLength !== undefined) add(`${name}.length <= ${c.maxLength}`, `${label} must be at most ${c.maxLength} characters`);
      if (c.pattern !== undefined) add(`Regex(${kotlinString(c.pattern)}).containsMatchIn(${name})`, `${label} must match ${c.pattern}`);
    }
    if (base.startsWith("List<")) {
      if (c.minItems !== undefined) add(`${name}.size >= ${c.minItems}`, `${label} must have at least ${items(c.minItems)}`);
      if (c.maxItems !== undefined) add(`${name}.size <= ${c.maxItems}`, `${label} must have at most ${items(c.maxItems)}`);
    }
    for (const check of boundChecks(name, label, c, type)) add(check.condition, check.message);
    return out;
  }

  private defaultLiteral(value: unknown, ref: TypeRef, type: KtTypeUse): string | undefined {
    return renderDefault(value, ref, type, {
      declaration: (id) => this.decls.get(id) ?? this.nested.get(id)?.decl,
      source: (id) => this.types.get(id),
      typeUse: (reference) => this.typeUse(reference),
      propertyName: (id, name) => this.propertyName(id, name),
      enumMemberName: (name) => this.memberName(name),
      ...(this.options.features?.values["optional-presence"] || this.options.features?.values["strict-optionals"]
        ? { optionalValue: `${this.options.modelsPackage}.OptionalValue` } : {}),
      ...(this.options.features?.values["strict-optionals"] ? { strictOptionals: true } : {}),
    });
  }

  private checkDuplicates(): void {
    const seen = new Map<string, string>();
    for (const decl of this.decls.values()) {
      const first = seen.get(decl.fqn);
      if (first) {
        reportDiagnostic(this.program, {
          code: "duplicate-type-name",
          format: { fqn: decl.fqn, first, second: decl.id },
          target: NoTarget,
        });
      } else {
        seen.set(decl.fqn, decl.id);
      }
    }
  }
}

/** How often each named type is referenced across the IR's types and services. */
function countNamedUses(api: ApiIR): Map<string, number> {
  const uses = new Map<string, number>();
  const count = (id: string | undefined) => {
    if (id) uses.set(id, (uses.get(id) ?? 0) + 1);
  };
  const visit = (ref: TypeRef | undefined): void => {
    if (!ref) return;
    switch (ref.kind) {
      case "named":
        count(ref.id);
        ref.args?.forEach(visit);
        return;
      case "array":
      case "map":
      case "nullable":
        visit(ref.of);
        return;
    }
  };
  for (const t of api.types) {
    if (t.kind === "model") {
      t.properties.forEach((p) => visit(p.type));
      visit(t.additionalProperties);
      count(t.baseId);
      t.templateArgs?.forEach(visit);
    } else if (t.kind === "union") {
      t.variants.forEach((v) => visit(v.type));
    }
  }
  for (const group of api.services.flatMap((s) => s.groups)) {
    for (const op of group.operations) {
      op.params.forEach((p) => visit(p.type));
      visit(op.body?.type);
      for (const r of op.responses) {
        visit(r.body?.type);
        r.headers.forEach((h) => visit(h.type));
      }
    }
  }
  return uses;
}

/** `c` without the constraints a value-class property's scalar already checks in its own init block. */
function withoutScalarConstraints(c: ConstraintsIR, ref: TypeRef): ConstraintsIR | undefined {
  const scalar = ref.kind === "nullable" ? ref.of : ref;
  const own = scalar.kind === "scalar" ? scalar.custom?.constraints : undefined;
  if (!own) return c;
  const rest = Object.entries(c).filter(([key, value]) => own[key as keyof ConstraintsIR] !== value);
  return rest.length > 0 ? (Object.fromEntries(rest) as ConstraintsIR) : undefined;
}

/** Simple identifiers in a Kotlin type expression (`Map<String, List<Pet>>` → Map, String, List, Pet). */
function identifiers(text: string): string[] {
  return text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
}
