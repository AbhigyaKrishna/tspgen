import type {
  ApiIR,
  ConstraintsIR,
  CustomScalarIR,
  DecoratorData,
  EnumIR,
  ModelIR,
  PropertyIR,
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
import { kotlinString } from "../kotlin-string.js";
import { reportDiagnostic, type EnumMemberNaming } from "../lib.js";
import { camel, identifier, typeName, upperSnake } from "../naming.js";
import { decoratorArg, decoratorArgs } from "./decorators.js";
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
  type DateTimeMapping,
  type DecimalMapping,
} from "./type-map.js";

type UnionShape = "enum" | "string-alias" | "sealed-interface" | "json";

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

const NUMERIC = new Set(["Byte", "Short", "Int", "Long", "ULong", "Float", "Double"]);

const SCALAR_STYLES: readonly ScalarStyle[] = ["inline", "typealias", "value-class"];

function items(n: number): string {
  return `${n} ${n === 1 ? "item" : "items"}`;
}

function isEmptyObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
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
  /** Value-class scalars used with a property's own `@encode(string)`: their generated `<Name>AsStringSerializer`. */
  private readonly usedValueClassAsString = new Map<string, { name: string; fqn: string; wraps: "Long" | "ULong" }>();

  constructor(
    private readonly program: Program,
    private readonly api: ApiIR,
    private readonly options: DeclarationOptions,
  ) {
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
    for (const t of own) if (t.kind === "model") this.fillModel(t);
    for (const t of own) if (t.kind === "union" && this.unionShape(t) === "sealed-interface") this.fillUnion(t);
    this.fillChecks();
    if (this.options.unionVariants !== "top-level") {
      const uses = countNamedUses(this.api);
      for (const t of own) if (t.kind === "union" && this.unionShape(t) === "sealed-interface") this.nestVariants(t, uses);
    }
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
        return listOf(this.typeUse(ref.of));
      case "map":
        return mapOf(this.typeUse(ref.of));
      case "scalar": {
        const fqn = decoratorArg(ref.custom?.decorators, "Kotlin.type");
        if (fqn) return fqnTypeUse(fqn);
        const std = this.stdScalarUse(ref.name);
        const base = ref.encoding === "string" ? this.stringEncoded(std) : std;
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
          return { text: decl.name, imports: [decl.fqn], nullable: false, underlying: decl.value, wrapper: "value-class" };
        }
        return base;
      }
      case "literal":
        return scalarTypeUse(
          typeof ref.value === "string"
            ? "string"
            : typeof ref.value === "boolean"
              ? "boolean"
              : Number.isInteger(ref.value)
                ? "int32"
                : "float64",
        );
      case "nullable":
        return nullable(this.typeUse(ref.of));
      case "file":
        this.usesFile = true;
        return { text: "HttpFile", imports: [this.httpFileFqn], nullable: false };
      case "unknown":
        return JSON_ELEMENT;
    }
  }

  /** A std scalar's type use; a java.time / java.math class is written qualified when a generated type takes its name. */
  private stdScalarUse(name: string): KtTypeUse {
    const scalar = scalarTypeUse(name, this.options.dateTime, this.options.decimal);
    const [fqn] = scalar.imports.filter((i) => i.startsWith("java.time.") || i.startsWith("java.math."));
    return fqn && this.hasName(scalar.text) ? { text: fqn, imports: [], nullable: false } : scalar;
  }

  /**
   * `@encode(string)`: Long (int64, integer, safeint) with kotlinx's LongAsStringSerializer, ULong with the generated
   * ULongAsStringSerializer. BigDecimal and String decimals already write strings.
   */
  private stringEncoded(type: KtTypeUse): KtTypeUse {
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
    if (nested) return { text: `${nested.parent.name}.${nested.decl.name}`, imports: [nested.parent.fqn], nullable: false };
    const decl = this.decls.get(id);
    return decl ? { text: decl.name, imports: [decl.fqn], nullable: false } : JSON_ELEMENT;
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
    if (item.deprecated) list.push(`@Deprecated(${kotlinString(item.deprecated)})`);
    list.push(...decoratorArgs(item.decorators, "Kotlin.annotate"));
    list.push(...metaStrings(this.program, resolveMeta(scopes, "kotlin"), "annotations", where));
    // Merged scopes concatenate arrays, so an annotation inherited from several levels repeats.
    return [...new Set(list)];
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
        return t.members.every((m) => typeof m.value === "string")
          ? { ...base, kind: "enum", members: [] }
          : { ...base, kind: "typealias", target: JSON_ELEMENT };
      case "union":
        if (t.events) return { ...base, kind: "events", events: [] };
        switch (this.unionShape(t)) {
          case "enum":
            return { ...base, kind: "enum", members: [] };
          case "sealed-interface":
            return { ...base, kind: "sealed-interface", discriminator: t.discriminator!.property, properties: [], implements: [...implementsMeta], variants: [] };
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
    const value = s.encoding === "string" ? this.stringEncoded(std) : std;
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
    return { ...base, kind: "value-class", value, checks: c ? this.constraintChecks("value", name, c, value, false) : [] };
  }

  private unionShape(u: UnionIR): UnionShape {
    const types = u.variants.map((v) => v.type);
    const stringLiterals = types.filter((t) => t.kind === "literal" && typeof t.value === "string").length;
    if (stringLiterals === types.length) return "enum";
    const strings = types.filter((t) => t.kind === "scalar" && t.name === "string").length;
    if (stringLiterals > 0 && stringLiterals + strings === types.length) return "string-alias";
    if (
      u.discriminator?.envelope === "none" &&
      types.every((t) => {
        const model = t.kind === "named" && !t.args?.length ? this.types.get(t.id) : undefined;
        return model?.kind === "model" && !model.typeParameters?.length;
      })
    ) {
      return "sealed-interface";
    }
    return "json";
  }

  private memberName(name: string): string {
    return this.options.enumMemberNaming === "PascalCase" ? typeName(name) : upperSnake(name);
  }

  private fillEnum(e: EnumIR): void {
    const decl = this.decls.get(e.id)!;
    if (decl.kind === "enum") {
      decl.members = e.members.map(
        (m): KtEnumMember => ({
          name: identifier(decoratorArg(m.decorators, "Kotlin.name") ?? this.memberName(m.name)),
          serialName: String(m.value),
          ...(m.docs ? { docs: m.docs } : {}),
          annotations: this.annotations(m, `${e.id}.${m.name}`),
          meta: metaScopes(m.decorators),
        }),
      );
      this.fillUnknown(decl, e);
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
    if (decl.kind === "enum") {
      decl.members = u.variants.map((v) => {
        const value = v.type.kind === "literal" ? String(v.type.value) : "";
        return {
          name: identifier(this.memberName(v.name ?? value)),
          serialName: value,
          ...(v.docs ? { docs: v.docs } : {}),
          annotations: [],
          meta: {},
        };
      });
      this.fillUnknown(decl, u);
    } else if (decl.kind === "sealed-interface") {
      for (const variant of u.variants) {
        if (variant.type.kind !== "named") continue;
        const target = this.decls.get(variant.type.id);
        if (target?.kind !== "data-class") continue;
        target.implements.push(decl.fqn);
        if (target.serialName === undefined && variant.name) target.serialName = variant.name;
        target.properties = target.properties.filter((p) => p.wireName !== decl.discriminator);
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
      return {
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
    this.modelProps.set(model.id, new Map(props.map((p) => [p.wireName, p])));
    this.fillSealedParents(model, decl, sealedBases);
    if (chain.some((m) => m.additionalProperties)) {
      reportDiagnostic(this.program, { code: "additional-properties", format: { id: model.id }, target: NoTarget });
    }
  }

  /**
   * Fills `checks` on every data class, after sealed unions have removed discriminator
   * properties (`fillUnion` runs after `fillModel` for sealed interfaces) — so a check for a
   * property no longer on the class is never emitted. Property order first, then @meta lines.
   */
  private fillChecks(): void {
    for (const [id, byWireName] of this.modelProps) {
      const decl = this.decls.get(id);
      if (decl?.kind !== "data-class") continue;
      decl.checks = [
        ...decl.properties.flatMap((prop) => {
          const p = byWireName.get(prop.wireName);
          return p ? this.checks(p, prop, `${id}.${p.name}`) : [];
        }),
        ...metaStrings(this.program, resolveMeta(decl.meta, "kotlin"), "checks", id),
      ];
    }
  }

  private fillSealedParents(model: ModelIR, decl: KtDataClass, sealedBases: ModelIR[]): void {
    for (const base of sealedBases) {
      decl.implements.push(this.decls.get(base.id)!.fqn);
      const value = Object.entries(base.discriminator!.mapping).find(([, id]) => id === model.id)?.[0];
      if (value !== undefined) decl.serialName = value;
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
    if (defaultValue !== undefined) prop.default = defaultValue;
    else if (p.optional) prop.default = "null";
    return prop;
  }

  /**
   * `require` lines for a property: its constraint decorators when `validation` is on, and the
   * `notBlank` meta flag (an explicit request, so emitted regardless of `validation`). Typealias scalars are checked
   * as their base type; value-class scalars through `.value`, minus the constraints the class checks itself.
   */
  private checks(p: PropertyIR, prop: KtProperty, where: string): string[] {
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
    return this.constraintChecks(expr, p.name, c, type, notBlank, prop.name);
  }

  /** `require` lines checking `c` (and `notBlank`) on `expr` of `type`; `guard` is null-checked first when nullable. */
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
      out.push(`require(${guarded}) { ${kotlinString(message)} }`);
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
    if (NUMERIC.has(base) || base === "BigDecimal") {
      // ULong compares only with unsigned literals (a non-positive lower bound always holds); BigDecimal with BigDecimal.
      const literal = (v: number) =>
        base === "ULong" ? `${v}uL` : base === "BigDecimal" ? `BigDecimal(${kotlinString(String(v))})` : String(v);
      if (c.minValue !== undefined && !(base === "ULong" && c.minValue <= 0)) {
        add(`${name} >= ${literal(c.minValue)}`, `${label} must be at least ${c.minValue}`);
      }
      if (c.maxValue !== undefined) add(`${name} <= ${literal(c.maxValue)}`, `${label} must be at most ${c.maxValue}`);
    }
    return out;
  }

  private defaultLiteral(value: unknown, ref: TypeRef, type: KtTypeUse): string | undefined {
    if (Array.isArray(value)) return value.length === 0 && ref.kind === "array" ? "emptyList()" : undefined;
    if (ref.kind === "map") return isEmptyObject(value) ? "emptyMap()" : undefined;
    if (ref.kind === "named") {
      const decl = this.decls.get(ref.id);
      // `#{}` for a model whose properties all have defaults (TypeSpec checks assignability).
      if (decl?.kind === "data-class") return isEmptyObject(value) ? `${decl.name}()` : undefined;
      if (decl?.kind === "enum") {
        const member = decl.members.find((m) => m.serialName === String(value));
        return member ? `${decl.name}.${member.name}` : undefined;
      }
      const mapped = this.mapped.get(ref.id);
      const source = this.types.get(ref.id);
      if (mapped && source?.kind === "enum") {
        const member = source.members.find((m) => String(m.value) === String(value));
        return member
          ? `${mapped.text}.${identifier(decoratorArg(member.decorators, "Kotlin.name") ?? this.memberName(member.name))}`
          : undefined;
      }
      return undefined;
    }
    if (type.underlying) {
      const inner = this.defaultLiteral(value, ref, type.underlying);
      if (inner === undefined) return undefined;
      // `type.text` may carry a trailing `?` (a nullable property with a default keeps the non-null literal).
      return type.wrapper === "value-class" ? `${type.text.replace(/\?$/, "")}(${inner})` : inner;
    }
    if (typeof value === "string") return type.text === "String" ? kotlinString(value) : undefined;
    if (typeof value === "boolean") return String(value);
    if (typeof value !== "number") return undefined;
    switch (type.text) {
      case "Long":
        return `${value}L`;
      case "ULong":
        return Number.isInteger(value) && value >= 0 ? `${value}uL` : undefined;
      case "BigDecimal":
        return `BigDecimal(${kotlinString(String(value))})`;
      case "Float":
        return `${value}f`;
      case "Double":
        return Number.isInteger(value) ? `${value}.0` : String(value);
      case "Int":
      case "Short":
      case "Byte":
        return String(value);
      default:
        return undefined;
    }
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
