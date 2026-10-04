import {
  getDiscriminatedUnion,
  getDiscriminator,
  getEncode,
  getEntityName,
  getFriendlyName,
  getMaxItems,
  getMaxLength,
  getMaxValue,
  getMinItems,
  getMinLength,
  getMinValue,
  getNamespaceFullName,
  getPattern,
  getTypeName,
  isArrayModelType,
  isNullType,
  isRecordModelType,
  isTemplateDeclaration,
  isTemplateInstance,
  navigateTypesInNamespace,
  NoTarget,
  resolveEncodedName,
  serializeValueAsJson,
  type Entity,
  type Enum,
  type Model,
  type ModelProperty,
  type Namespace,
  type Program,
  type Scalar,
  type Type,
  type Union,
  type UnionVariant,
} from "@typespec/compiler";
import { getHttpPart, isBody, isBodyRoot, isMetadata, isOrExtendsHttpFile } from "@typespec/http";
import { reportDiagnostic } from "../lib.js";
import { pascal } from "../naming.js";
import { collectDecorators, namespaceDecoratorsField } from "./decorators.js";
import { docInfo } from "./docs.js";
import { isEventsUnion, type SseLibraries } from "./sse.js";
import type { ConstraintsIR, CustomScalarIR, EnumIR, EventIR, ModelIR, PropertyIR, TypeIR, TypeRef, UnionIR } from "./types.js";
import type { ResolvedService } from "./versioning.js";

const UNKNOWN: TypeRef = { kind: "unknown" };
const FILE: TypeRef = { kind: "file" };
/** Std roots `@encode(string)` turns into JSON strings (base-10 integers, decimal strings). */
const STRING_ENCODABLE = new Set(["int64", "uint64", "integer", "safeint", "decimal", "decimal128"]);
/** Encodings naming a scalar's default JSON form: accepted without a warning. */
const DEFAULT_ENCODINGS: Record<string, readonly string[]> = {
  utcDateTime: ["rfc3339"],
  offsetDateTime: ["rfc3339"],
  duration: ["ISO8601"],
  bytes: ["base64"],
};

/** Converts TypeSpec types into TypeRefs, collecting named/anonymous declarations as TypeIR. */
export class TypeCollector {
  private readonly types = new Map<string, TypeIR>();
  private readonly ids = new Map<Type, string>();
  /** Template declarations checked by `declarationGeneric` (true while being checked, for recursion). */
  private readonly genericDeclarations = new Map<Model, boolean>();
  /** `genericsFor` results by declaration, so a `generics` callback runs once per template declaration. */
  private readonly genericsCache = new Map<Model, boolean>();
  /** Ids already reported by `version-conflict`. */
  private readonly conflicts = new Set<string>();
  /**
   * Declarations already reported by `unsupported-encoding`, keyed by the declaring node (see
   * `declaringEncodeTarget`): spread, `model … is …` and template-instantiated copies of a property share their
   * origin's node, so keying on it (rather than e.g. `getTypeName`, which differs per copy) collapses every copy
   * of the same written `@encode` into one warning.
   */
  private readonly encodingReported = new Set<unknown>();
  /**
   * `CustomScalarIR` by the `Scalar` it describes, so every `TypeRef.custom` pointing at the same scalar shares one
   * object (see `getCustomScalars`): a mutation (e.g. `stripDocs` deleting `docs`) is then visible through every
   * reference, rather than only the ref that happened to be mutated.
   */
  private readonly customScalars = new Map<Scalar, CustomScalarIR>();
  /** The service being built, when its namespace is a mutated (versioned) clone. */
  private service?: {
    /** Template declarations of the mutated namespace by node: instances point at the original declaration. */
    declarations: Map<unknown, Model>;
    versionEnum?: unknown;
  };

  constructor(
    private readonly program: Program,
    private readonly options: { generics: boolean | ((declaration: Model) => boolean); sse?: SseLibraries | undefined } = {
      generics: true,
    },
  ) {}

  /** The TypeSpec type collected under `id`, if any. */
  sourceOf(id: string): Type | undefined {
    for (const [type, typeId] of this.ids) if (typeId === id) return type;
    return undefined;
  }

  /** The type collected under `id`, if any. */
  typeOf(id: string): TypeIR | undefined {
    return this.types.get(id);
  }

  getTypes(): TypeIR[] {
    return [...this.types.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Every distinct custom scalar referenced so far (see `customScalars`), one entry per `Scalar`. */
  getCustomScalars(): CustomScalarIR[] {
    return [...this.customScalars.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Set the service whose types are collected next. Types of a mutated (versioned) namespace are clones:
   * template instances are matched with the cloned declarations, and the version enum is not collected.
   */
  enterService(service: ResolvedService | undefined): void {
    if (!service?.mutated) {
      this.service = undefined;
      return;
    }
    const declarations = new Map<unknown, Model>();
    navigateTypesInNamespace(
      service.namespace,
      {
        model: (m) => {
          if (m.node && isTemplateDeclaration(m)) declarations.set(m.node, m);
        },
      },
      { includeTemplateDeclaration: true },
    );
    this.service = { declarations, versionEnum: service.versionEnum?.node };
  }

  /** Collect every declared model/enum/union in a namespace (recursively), even if unreferenced. */
  collectNamespace(ns: Namespace): void {
    navigateTypesInNamespace(ns, {
      model: (m) => {
        if (
          m.name &&
          !isTemplateDeclaration(m) &&
          !this.isCollection(m) &&
          !this.isHttpEnvelope(m) &&
          !isOrExtendsHttpFile(this.program, m)
        ) {
          // Partial instances inside template declarations (`Link<T>`) are not types of their own.
          if (this.mentionsTemplateParameter(m)) return;
          // A template instance that can be generic contributes its declaration, not a model of its own.
          if (!this.genericRef(m, m.name)) this.collectModel(m, m.name);
        }
      },
      enum: (e) => {
        if (!e.node || e.node !== this.service?.versionEnum) this.collectEnum(e);
      },
      union: (u) => {
        // An @events union is generated only when a stream (or a JSON use) refers to it.
        if (u.name && !isTemplateDeclaration(u) && !isEventsUnion(this.program, u, this.options.sse)) this.unionRef(u, u.name);
      },
    });
  }

  ref(type: Type, hint: string): TypeRef {
    switch (type.kind) {
      case "Model":
        return this.modelRef(type, hint);
      case "ModelProperty":
        return this.ref(type.type, hint);
      case "Scalar":
        return this.scalarRef(type);
      case "Enum":
        return { kind: "named", id: this.collectEnum(type) };
      case "EnumMember":
        return { kind: "literal", value: type.value ?? type.name };
      case "Union":
        return this.unionRef(type, hint);
      case "String":
      case "Number":
      case "Boolean":
        return { kind: "literal", value: type.value };
      case "Intrinsic":
        if (type.name === "unknown") return UNKNOWN;
        break;
      case "TemplateParameter":
        return { kind: "typeParam", name: (type.node as { id: { sv: string } }).id.sv };
    }
    reportDiagnostic(this.program, { code: "unsupported-type", format: { kind: type.kind }, target: type ?? NoTarget });
    return UNKNOWN;
  }

  /**
   * The type of a model property, parameter or header: its type's ref, with the property's own `@encode` (which wins
   * over the scalar's) applied to a scalar or `Scalar | null`. `state`: the property whose decorator state applies.
   * `@encode` on any other shape (a union with several non-null members, or a named union) is reported once per
   * declaration (`unsupported-encoding`) and ignored, rather than silently dropped.
   */
  propertyRef(prop: ModelProperty, hint: string, state: ModelProperty = prop): TypeRef {
    return this.applyEncode(this.ref(prop.type, hint), state);
  }

  /**
   * `ref` with `state`'s own `@encode` applied, for a `ref` already computed from a value type other than
   * `state.type` (a multipart part's `T`, once `HttpPart<T>[]` has been unwrapped and the repetition dropped into
   * `PartIR.multi`): `propertyRef` cannot be used there, since re-deriving the ref from `state.type` directly would
   * wrap it back into an array.
   */
  encodeRef(ref: TypeRef, state: ModelProperty): TypeRef {
    return this.applyEncode(ref, state);
  }

  private applyEncode(ref: TypeRef, state: ModelProperty): TypeRef {
    const data = getEncode(this.program, state);
    if (!data) return ref;
    const target = ref.kind === "nullable" ? ref.of : ref;
    if (target.kind !== "scalar") {
      this.reportUnsupportedEncoding(state, data.encoding ?? "string");
      return ref;
    }
    const encoding = this.encoding(state, target.name);
    const encoded: TypeRef = {
      kind: "scalar",
      name: target.name,
      ...(target.custom ? { custom: target.custom } : {}),
      ...(encoding ? { encoding } : {}),
    };
    return ref.kind === "nullable" ? { kind: "nullable", of: encoded } : encoded;
  }

  /**
   * `"string"` for `@encode(string)` on a string-encodable number; undefined for none or a scalar's default JSON
   * encoding. Anything else is reported once per declaration and ignored.
   */
  private encoding(target: ModelProperty | Scalar, root: string): "string" | undefined {
    const data = getEncode(this.program, target);
    if (!data) return undefined;
    const encoding = data.encoding ?? "string";
    if (encoding === "string" && STRING_ENCODABLE.has(root)) return "string";
    if (DEFAULT_ENCODINGS[root]?.includes(encoding)) return undefined;
    this.reportUnsupportedEncoding(target, encoding);
    return undefined;
  }

  /**
   * Reports `unsupported-encoding` once per declaration: the key and diagnostic target are the declaring node of
   * `source`'s `@encode` (see `declaringEncodeTarget`), so spread, `model … is …` and template-instantiated copies
   * of the same declared property warn only once, no matter how many copies are collected.
   */
  private reportUnsupportedEncoding(source: ModelProperty | Scalar, encoding: string): void {
    const { key, target } = declaringEncodeTarget(source);
    if (this.encodingReported.has(key)) return;
    this.encodingReported.add(key);
    reportDiagnostic(this.program, { code: "unsupported-encoding", format: { encoding, where: getTypeName(source) }, target });
  }

  private isCollection(model: Model): boolean {
    return isArrayModelType(model) || (isRecordModelType(model) && model.name === "Record");
  }

  /** Models carrying HTTP metadata/body properties describe requests/responses, not data. */
  private isHttpEnvelope(model: Model): boolean {
    return [...model.properties.values()].some(
      (p) => isMetadata(this.program, p) || isBody(this.program, p) || isBodyRoot(this.program, p),
    );
  }

  /** The type of the `@body` / `@bodyRoot` property of an HTTP envelope model, if it has one. */
  private envelopeBody(model: Model): Type | undefined {
    for (const p of model.properties.values()) {
      if (isBody(this.program, p) || isBodyRoot(this.program, p)) return p.type;
    }
    return undefined;
  }

  /** `generic: false` collects a template instance as its own model even when it could be generic. */
  private modelRef(model: Model, hint: string, generic = true): TypeRef {
    // Http.File (and models extending it) are the languages' file types; HttpPart<T> is T.
    if (isOrExtendsHttpFile(this.program, model)) return FILE;
    const part = getHttpPart(this.program, model);
    if (part) {
      // A part declared with an envelope (`HttpPart<{ @header contentType: …; @body value: T }>`) carries T.
      const value = (part.type.kind === "Model" && this.envelopeBody(part.type)) || part.type;
      return isBytes(value) ? FILE : this.ref(value, hint);
    }
    if (isArrayModelType(model)) return { kind: "array", of: this.ref(model.indexer.value, `${hint}Item`) };
    if (isRecordModelType(model) && model.name === "Record") {
      return { kind: "map", of: this.ref(model.indexer.value, `${hint}Value`) };
    }
    // Inside a template declaration `T[]` / `Record<T>` have a template-parameter argument and no indexer yet.
    const [element] = this.stdCollectionArgs(model);
    if (element) {
      return model.name === "Array"
        ? { kind: "array", of: this.ref(element, `${hint}Item`) }
        : { kind: "map", of: this.ref(element, `${hint}Value`) };
    }
    const source = this.spreadSource(model) ?? model;
    if (generic) {
      const ref = this.genericRef(source, hint);
      if (ref) return ref;
    }
    return { kind: "named", id: this.collectModel(source, hint) };
  }

  private stdCollectionArgs(model: Model): Type[] {
    if ((model.name !== "Array" && model.name !== "Record") || !model.namespace) return [];
    if (getNamespaceFullName(model.namespace) !== "TypeSpec") return [];
    return (model.templateMapper?.args ?? []).filter((a): a is Type => (a as { entityKind?: string }).entityKind === "Type");
  }

  /** `Page<Pet>` → the generic `Page` (collected once) with args [Pet], when the template can be generic. */
  private genericRef(instance: Model, hint: string): TypeRef | undefined {
    const generic = this.genericTemplate(instance);
    if (!generic) return undefined;
    // Decorators do not run on template declarations, so docs, encoded names and constraints come
    // from the instance's properties.
    const id = this.collectModel(generic.declaration, generic.declaration.name, instance);
    return { kind: "named", id, args: generic.args.map((arg, i) => this.ref(arg, `${hint}Arg${i + 1}`)) };
  }

  /** The declaration and type arguments of an instance that can be emitted as a use of a generic model. */
  private genericTemplate(instance: Model): { declaration: Model; args: Type[] } | undefined {
    const args = instance.templateMapper?.args ?? [];
    if (args.length === 0 || !instance.templateNode) return undefined;
    const declaration =
      this.service?.declarations.get(instance.templateNode) ?? this.program.checker.getTypeForNode(instance.templateNode);
    if (declaration.kind !== "Model" || !isTemplateDeclaration(declaration)) return undefined;
    if (!this.genericsFor(declaration)) return undefined;
    const types = args.filter(
      (arg): arg is Type =>
        (arg as { entityKind?: string }).entityKind === "Type" &&
        ((arg as Type).kind !== "Intrinsic" || (arg as { name?: string }).name === "unknown"),
    );
    if (types.length !== args.length || !this.expressible(instance, declaration)) return undefined;
    return this.declarationGeneric(declaration) ? { declaration, args: types } : undefined;
  }

  /**
   * Whether a template declaration may be emitted as a generic model (the `generics` option or callback). A
   * callback's result is cached per declaration, so it runs once even when the declaration is referenced from
   * several instances.
   */
  private genericsFor(declaration: Model): boolean {
    const { generics } = this.options;
    if (typeof generics !== "function") return generics;
    const cached = this.genericsCache.get(declaration);
    if (cached !== undefined) return cached;
    const result = generics(declaration);
    this.genericsCache.set(declaration, result);
    return result;
  }

  /**
   * A template is generic unless it needs per-instance models: a base model or discriminator, HTTP
   * metadata, `...T` spreads (instance and declaration properties differ) or a @friendlyName.
   * Decorators do not run on declarations, so those are found among the declaration's applications.
   */
  private expressible(instance: Model, declaration: Model): boolean {
    if (declaration.baseModel || getDiscriminator(this.program, instance)) return false;
    if (applies(declaration, "discriminator") || applies(declaration, "friendlyName")) return false;
    if (getFriendlyName(this.program, instance)) return false;
    if (this.isHttpEnvelope(declaration) || this.isHttpEnvelope(instance)) return false;
    const names = (m: Model) => [...m.properties.keys()].join("\0");
    return names(instance) === names(declaration);
  }

  /**
   * Whether every use of a type parameter in the declaration can be written in a generic class: directly,
   * in arrays/records, `T | null`, or as an argument of another generic template. An anonymous model or a
   * union mentioning `T` would need a generic declaration of its own, so such templates stay per-instance.
   */
  private declarationGeneric(declaration: Model): boolean {
    const known = this.genericDeclarations.get(declaration);
    if (known !== undefined) return known;
    this.genericDeclarations.set(declaration, true); // assume true while recursing into itself
    const ok = [...declaration.properties.values()].every((p) => this.genericSafe(p.type));
    this.genericDeclarations.set(declaration, ok);
    return ok;
  }

  private genericSafe(type: Type): boolean {
    if (!this.mentionsTemplateParameter(type)) return true;
    switch (type.kind) {
      case "TemplateParameter":
        return true;
      case "Model": {
        const [element] = this.stdCollectionArgs(type);
        if (element) return this.genericSafe(element);
        if (isArrayModelType(type) || isRecordModelType(type)) return this.genericSafe(type.indexer!.value);
        const generic = this.genericTemplate(type);
        return generic !== undefined && generic.args.every((arg) => this.genericSafe(arg));
      }
      case "Union": {
        const variants = [...type.variants.values()].filter((v) => !isNullType(v.type));
        return !type.name && variants.length === 1 && this.genericSafe(variants[0].type);
      }
      default:
        return false;
    }
  }

  private mentionsTemplateParameter(type: Type, seen = new Set<Type>()): boolean {
    if (seen.has(type)) return false;
    seen.add(type);
    switch (type.kind) {
      case "TemplateParameter":
        return true;
      case "ModelProperty":
        return this.mentionsTemplateParameter(type.type, seen);
      case "Model":
        if ((type.templateMapper?.args ?? []).some((a) => isType(a) && this.mentionsTemplateParameter(a, seen))) return true;
        if (type.indexer && this.mentionsTemplateParameter(type.indexer.value, seen)) return true;
        return !type.name && [...type.properties.values()].some((p) => this.mentionsTemplateParameter(p.type, seen));
      case "Union":
        return [...type.variants.values()].some((v) => this.mentionsTemplateParameter(v.type, seen));
      default:
        return false;
    }
  }

  /**
   * HTTP bodies of envelope models (e.g. `@error model NotFound { @statusCode _: 404; ... }`) are
   * anonymous spreads of the named model minus its metadata; refer to the named model instead.
   */
  private spreadSource(model: Model): Model | undefined {
    if (model.name || model.sourceModels.length !== 1) return undefined;
    const [source] = model.sourceModels;
    return source.usage === "spread" && source.model.name ? source.model : undefined;
  }

  private scalarRef(scalar: Scalar): TypeRef {
    const name = this.stdScalarName(scalar);
    if (this.isStd(scalar)) return { kind: "scalar", name };
    // The nearest @encode along the user scalar chain (starting at this scalar itself) applies.
    const encoding = this.nearestEncoding(scalar, name);
    return {
      kind: "scalar",
      name,
      custom: this.customScalar(scalar, name, encoding),
      ...(encoding ? { encoding } : {}),
    };
  }

  /** The nearest `@encode` from `scalar` up its base chain to (not including) `root`'s std scalar; absent without one. */
  private nearestEncoding(scalar: Scalar, root: string): "string" | undefined {
    for (let current: Scalar | undefined = scalar; current && !this.isStd(current); current = current.baseScalar) {
      if (!getEncode(this.program, current)) continue;
      return this.encoding(current, root);
    }
    return undefined;
  }

  /**
   * Cached per `Scalar` (see `customScalars`) so every ref to the same scalar shares one `CustomScalarIR`. `root`/
   * `encoding` are `scalarRef`'s own (the same computed for a ref to `scalar` itself, since both start there).
   */
  private customScalar(scalar: Scalar, root: string, encoding: "string" | undefined): CustomScalarIR {
    const cached = this.customScalars.get(scalar);
    if (cached) return cached;
    const constraints = this.collectConstraints([scalar]);
    const ir: CustomScalarIR = {
      id: getTypeName(scalar),
      name: scalar.name,
      namespace: scalar.namespace ? splitNamespace(getNamespaceFullName(scalar.namespace)) : [],
      root,
      ...(encoding ? { encoding } : {}),
      ...docInfo(this.program, scalar),
      ...(constraints ? { constraints } : {}),
      decorators: collectDecorators(scalar),
      ...namespaceDecoratorsField(scalar),
    };
    this.customScalars.set(scalar, ir);
    return ir;
  }

  private stdScalarName(scalar: Scalar): string {
    let current = scalar;
    while (current.baseScalar && !this.isStd(current)) current = current.baseScalar;
    return current.name;
  }

  private isStd(scalar: Scalar): boolean {
    return scalar.namespace !== undefined && getNamespaceFullName(scalar.namespace) === "TypeSpec";
  }

  /**
   * Whether another type was already collected under `id`: a type outside a versioned service's namespace is
   * cloned with it, and services at different versions (a `@useDependency` service and the versioned one)
   * see different clones of the same declaration. The first one is kept.
   */
  private collected(type: Model | Union | Enum, id: string): boolean {
    if (!this.types.has(id)) return false;
    const first = this.sourceOf(id);
    this.ids.set(type, id);
    if (first && shape(first) !== shape(type) && !this.conflicts.has(id)) {
      this.conflicts.add(id);
      reportDiagnostic(this.program, { code: "version-conflict", format: { id }, target: type });
    }
    return true;
  }

  private identify(type: Model | Union | Enum, hint: string): { id: string; name: string; namespace: string[] } {
    if (type.name) {
      const friendly = getFriendlyName(this.program, type);
      const name = friendly ?? type.name + templateArgsName(type);
      const namespace = type.namespace ? splitNamespace(getNamespaceFullName(type.namespace)) : [];
      return { id: typeId(type), name, namespace };
    }
    const base = pascal(hint);
    let name = base;
    for (let i = 2; this.types.has(`$anon.${name}`); i++) name = `${base}${i}`;
    return { id: `$anon.${name}`, name, namespace: [] };
  }

  /** `state`: for a generic declaration, an instance whose decorator state (docs, encodings, constraints) applies. */
  private collectModel(model: Model, hint: string, state?: Model): string {
    const existing = this.ids.get(model);
    if (existing) return existing;
    const { id, name, namespace } = this.identify(model, hint);
    if (this.collected(model, id)) return id;
    this.ids.set(model, id);
    const ir: ModelIR = {
      kind: "model",
      id,
      name,
      namespace,
      ...docInfo(this.program, state ?? model),
      decorators: collectDecorators(model),
      ...namespaceDecoratorsField(model),
      properties: [],
    };
    if (isTemplateDeclaration(model)) ir.typeParameters = model.node!.templateParameters.map((p) => p.id.sv);
    if (hasParts(this.program, model)) ir.multipart = true;
    this.types.set(id, ir);
    for (const prop of model.properties.values()) {
      const stateProp = state?.properties.get(prop.name) ?? prop;
      if (isMetadata(this.program, stateProp)) continue;
      ir.properties.push(this.property(prop, name, stateProp));
    }
    if (model.baseModel) ir.baseId = this.collectModel(model.baseModel, `${name}Base`);
    if (model.indexer && isRecordModelType(model)) {
      ir.additionalProperties = this.ref(model.indexer.value, `${name}Value`);
    }
    const discriminator = getDiscriminator(this.program, model);
    if (discriminator) {
      ir.discriminator = {
        property: discriminator.propertyName,
        mapping: this.discriminatorMapping(model, discriminator.propertyName),
      };
    }
    // Template arguments only matter to mapping decorators (e.g. Kotlin.type); recording them
    // for undecorated instances would pull otherwise-unused argument types into the IR.
    const args = Object.keys(ir.decorators).length > 0 ? templateArgTypes(model) : [];
    if (args.length > 0) ir.templateArgs = args.map((arg, i) => this.ref(arg, `${name}Arg${i + 1}`));
    return id;
  }

  private discriminatorMapping(model: Model, property: string): Record<string, string> {
    const mapping: Record<string, string> = {};
    for (const derived of model.derivedModels) {
      const prop = derived.properties.get(property);
      if (!prop) continue;
      const id = this.collectModel(derived, derived.name);
      for (const value of literalValues(prop.type)) mapping[String(value)] = id;
    }
    return mapping;
  }

  /** `state`: the property whose decorator state applies (an instance's, for a generic declaration). */
  private property(prop: ModelProperty, parentName: string, state: ModelProperty = prop): PropertyIR {
    const ir: PropertyIR = {
      name: prop.name,
      wireName: resolveEncodedName(this.program, state, "application/json"),
      type: this.propertyRef(prop, `${parentName}${pascal(prop.name)}`, state),
      optional: prop.optional,
      ...docInfo(this.program, state),
      decorators: collectDecorators(prop),
    };
    const constraints = this.constraints(state);
    if (constraints) ir.constraints = constraints;
    if (state.defaultValue) ir.default = serializeValueAsJson(this.program, state.defaultValue, state.type);
    return ir;
  }

  /**
   * Constraint decorators of a property or parameter (then of its scalar type, also through `Scalar | null`);
   * undefined when none. Scalar-level constraints of array items (`Slug[]`) are not collected.
   */
  constraints(prop: ModelProperty): ConstraintsIR | undefined {
    const scalar = constrainedScalar(prop.type);
    return this.collectConstraints(scalar ? [prop, scalar] : [prop]);
  }

  /** The first value of each constraint decorator among `sources`, in order; undefined when none applies. */
  private collectConstraints(sources: readonly Type[]): ConstraintsIR | undefined {
    const first = <T>(get: (program: Program, target: Type) => T | undefined): T | undefined => {
      for (const source of sources) {
        const value = get(this.program, source);
        if (value !== undefined) return value;
      }
      return undefined;
    };
    const all: ConstraintsIR = {
      minLength: first(getMinLength),
      maxLength: first(getMaxLength),
      minItems: first(getMinItems),
      maxItems: first(getMaxItems),
      minValue: first(getMinValue),
      maxValue: first(getMaxValue),
      pattern: first(getPattern),
    };
    const set = Object.entries(all).filter(([, value]) => value !== undefined);
    return set.length > 0 ? (Object.fromEntries(set) as ConstraintsIR) : undefined;
  }

  private collectEnum(e: Enum): string {
    const existing = this.ids.get(e);
    if (existing) return existing;
    const { id, name, namespace } = this.identify(e, e.name);
    if (this.collected(e, id)) return id;
    this.ids.set(e, id);
    const ir: EnumIR = {
      kind: "enum",
      id,
      name,
      namespace,
      ...docInfo(this.program, e),
      decorators: collectDecorators(e),
      ...namespaceDecoratorsField(e),
      members: [...e.members.values()].map((m) => ({
        name: m.name,
        value: m.value ?? m.name,
        ...docInfo(this.program, m),
        decorators: collectDecorators(m),
      })),
    };
    this.types.set(id, ir);
    return id;
  }

  private unionRef(union: Union, hint: string): TypeRef {
    if (isEventsUnion(this.program, union, this.options.sse)) return { kind: "named", id: this.collectEvents(union, hint) };
    const variants = [...union.variants.values()];
    const nonNull = variants.filter((v) => !isNullType(v.type));
    const single = !union.name && nonNull.length === 1;
    const inner: TypeRef = single
      ? this.ref(nonNull[0].type, hint)
      : { kind: "named", id: this.collectUnion(union, hint, nonNull) };
    return nonNull.length < variants.length ? { kind: "nullable", of: inner } : inner;
  }

  private collectUnion(union: Union, hint: string, variants: UnionVariant[]): string {
    const existing = this.ids.get(union);
    if (existing) return existing;
    const { id, name, namespace } = this.identify(union, hint);
    if (this.collected(union, id)) return id;
    this.ids.set(union, id);
    const ir: UnionIR = {
      kind: "union",
      id,
      name,
      namespace,
      ...docInfo(this.program, union),
      decorators: collectDecorators(union),
      ...namespaceDecoratorsField(union),
      variants: [],
    };
    this.types.set(id, ir);
    // Variants of a discriminated union are distinct classes (Kotlin sealed subclasses), so a template
    // variant (`created: Created<Pet>`) gets a model of its own rather than a use of a generic one.
    const isDiscriminated = getDiscriminatedUnion(this.program, union)[0] !== undefined;
    ir.variants = variants.map((v) => {
      const variantName = typeof v.name === "string" ? v.name : undefined;
      const hint = `${name}${variantName ? pascal(variantName) : "Variant"}`;
      return {
        ...(variantName ? { name: variantName } : {}),
        type: isDiscriminated && v.type.kind === "Model" ? this.modelRef(v.type, hint, false) : this.ref(v.type, hint),
        ...docInfo(this.program, v),
      };
    });
    const [discriminated] = getDiscriminatedUnion(this.program, union);
    if (discriminated) {
      ir.discriminator = {
        property: discriminated.options.discriminatorPropertyName,
        envelope: discriminated.options.envelope,
        envelopeProperty: discriminated.options.envelopePropertyName,
      };
    }
    return id;
  }

  /**
   * An `@events` union: a union whose variants are the event payloads, plus the events (name, payload, content type,
   * terminal) from `@typespec/events` / `@typespec/sse`.
   */
  private collectEvents(union: Union, hint: string): string {
    const existing = this.ids.get(union);
    if (existing) return existing;
    const { id, name, namespace } = this.identify(union, hint);
    if (this.collected(union, id)) return id;
    this.ids.set(union, id);
    const ir: UnionIR = {
      kind: "union",
      id,
      name,
      namespace,
      ...docInfo(this.program, union),
      decorators: collectDecorators(union),
      ...namespaceDecoratorsField(union),
      variants: [],
      events: [],
    };
    this.types.set(id, ir);
    const libs = this.options.sse!;
    const [definitions] = libs.getEventDefinitions(this.program, union);
    for (const definition of definitions) {
      const variant = definition.root;
      const variantName = typeof variant.name === "string" ? variant.name : undefined;
      const payload = this.ref(definition.payloadType, `${name}${pascal(variantName ?? "Message")}`);
      const { docs } = docInfo(this.program, variant);
      ir.variants.push({ ...(variantName ? { name: variantName } : {}), type: payload, ...(docs ? { docs } : {}) });
      const event: EventIR = {
        name: definition.eventType ?? "message",
        payload,
        contentType: definition.payloadContentType ?? defaultEventContentType(definition.payloadType),
        terminal: libs.isTerminalEvent(this.program, variant),
        ...(docs ? { docs } : {}),
      };
      ir.events!.push(event);
    }
    return id;
  }
}

/** "text/plain" for string payloads (scalars deriving from string, string literals), "application/json" otherwise. */
function defaultEventContentType(type: Type): string {
  if (type.kind === "String") return "text/plain";
  for (let current = type.kind === "Scalar" ? type : undefined; current; current = current.baseScalar) {
    if (current.name === "string" && current.namespace && getNamespaceFullName(current.namespace) === "TypeSpec") {
      return "text/plain";
    }
  }
  return "application/json";
}

/** What distinguishes versions of a declaration: its properties, members or variants. */
function shape(type: Type): string {
  switch (type.kind) {
    case "Model":
      return [...type.properties.values()].map((p) => `${p.name}${p.optional ? "?" : ""}:${typeId(p.type)}`).join(",");
    case "Enum":
      return [...type.members.values()].map((m) => `${m.name}=${m.value ?? ""}`).join(",");
    case "Union":
      return [...type.variants.values()].map((v) => `${String(v.name)}:${typeId(v.type)}`).join(",");
    default:
      return "";
  }
}

/** The root of a `sourceProperty` chain: where a `model … is …` or `...spread` copy's property originates. */
function rootProperty(prop: ModelProperty): ModelProperty {
  let current = prop;
  while (current.sourceProperty) current = current.sourceProperty;
  return current;
}

/**
 * The dedupe key and diagnostic target for an `unsupported-encoding` report on `source`: the node where `@encode`
 * was actually written. Spread, `model … is …` and template-instantiated copies of a property share their origin's
 * node (only new `ModelProperty` wrapper objects are created per copy), so keying on the node — rather than e.g.
 * `getTypeName`, which differs per copy (`M.a` vs `N.a` vs `Container<string>.stamp`) — collapses every copy of the
 * same declared `@encode` into one warning. `source.sourceProperty` is followed to the root first because a copy's
 * own node is not always defined (an `is`-copy may lack one); the property/scalar itself is the key when neither is.
 */
function declaringEncodeTarget(source: ModelProperty | Scalar) {
  const root = source.kind === "ModelProperty" ? rootProperty(source) : source;
  const target = root.node ?? root;
  return { key: target as unknown, target };
}

/** The `bytes` scalar or a scalar extending it. */
export function isBytes(type: Type): boolean {
  for (let current = type.kind === "Scalar" ? type : undefined; current; current = current.baseScalar) {
    if (current.name === "bytes" && current.namespace && getNamespaceFullName(current.namespace) === "TypeSpec") return true;
  }
  return false;
}

/** `HttpPart<T>` or `HttpPart<T>[]`. */
export function isPartType(program: Program, type: Type): boolean {
  if (type.kind !== "Model") return false;
  if (getHttpPart(program, type)) return true;
  return isArrayModelType(type) && type.indexer.value.kind === "Model" && getHttpPart(program, type.indexer.value) !== undefined;
}

/** Whether `model` declares (not inherits) `HttpPart` properties. */
export function hasParts(program: Program, model: Model): boolean {
  return [...model.properties.values()].some((p) => isPartType(program, p.type));
}

function literalValues(type: Type): (string | number | boolean)[] {
  switch (type.kind) {
    case "String":
    case "Number":
    case "Boolean":
      return [type.value];
    case "EnumMember":
      return [type.value ?? type.name];
    case "Union":
      return [...type.variants.values()].flatMap((v) => literalValues(v.type));
    default:
      return [];
  }
}

function templateArgsName(type: Model | Union | Enum): string {
  const args = (type as { templateMapper?: { args: readonly unknown[] } }).templateMapper?.args ?? [];
  return args
    .map((a) => (a && typeof a === "object" && "name" in a && typeof a.name === "string" ? pascal(a.name) : ""))
    .join("");
}

/**
 * `getTypeName`, except that template instances of unions keep their arguments (`S.Maybe<int32>`) — the compiler
 * prints a union instance as its bare name, so instances would share an id — including when nested in another
 * instance's arguments (`S.Maybe<S.Maybe<int32>>`, `S.Maybe<S.Box<S.Maybe<int32>>>`). Values print as in
 * `getEntityName`. Ids of everything else (non-template types, model instances without union-instance arguments)
 * are exactly `getTypeName`'s.
 */
function typeId(entity: Entity): string {
  if (!isType(entity)) return getEntityName(entity);
  switch (entity.kind) {
    case "Union":
      if (entity.name && isTemplateInstance(entity)) return `${getTypeName(entity)}${templateArgsId(entity.templateMapper.args)}`;
      if (!entity.name && entity.expression) return [...entity.variants.values()].map((v) => typeId(v.type)).join(" | ");
      return getTypeName(entity);
    case "Model":
      if (isArrayModelType(entity) && entity.name === "Array") return `${typeId(entity.indexer.value)}[]`;
      if (entity.name && isTemplateInstance(entity)) {
        // The compiler prints `<name><args>` with args via `getEntityName`: swap that suffix for recursive ids.
        const args = entity.templateMapper.args;
        const name = getTypeName(entity);
        const suffix = `<${args.map((a) => getEntityName(a)).join(", ")}>`;
        if (name.endsWith(suffix)) return name.slice(0, -suffix.length) + templateArgsId(args);
      }
      return getTypeName(entity);
    case "Tuple":
      return `[${entity.values.map(typeId).join(", ")}]`;
    default:
      return getTypeName(entity);
  }
}

function templateArgsId(args: readonly Entity[]): string {
  return args.length ? `<${args.map(typeId).join(", ")}>` : "";
}

export function splitNamespace(fullName: string): string[] {
  return fullName ? fullName.split(".") : [];
}

function templateArgTypes(model: Model): Type[] {
  return (model.templateMapper?.args ?? []).filter(
    (arg): arg is Type =>
      typeof arg === "object" &&
      arg !== null &&
      (arg as { entityKind?: string }).entityKind === "Type" &&
      (arg as Type).kind !== "Intrinsic",
  );
}

function isType(entity: unknown): entity is Type {
  return typeof entity === "object" && entity !== null && (entity as { entityKind?: string }).entityKind === "Type";
}

/** Whether a decorator named `name` is applied to `type` (also on template declarations, where it does not run). */
function applies(type: Model, name: string): boolean {
  return type.decorators.some((d) => d.definition?.name === `@${name}` || d.decorator.name === `$${name}`);
}

/** The scalar of `Scalar` or of an anonymous `Scalar | null`; undefined otherwise. */
function constrainedScalar(type: Type): Type | undefined {
  if (type.kind === "Scalar") return type;
  if (type.kind !== "Union" || type.name) return undefined;
  const variants = [...type.variants.values()];
  const nonNull = variants.filter((v) => !isNullType(v.type));
  return nonNull.length === 1 && nonNull.length < variants.length && nonNull[0].type.kind === "Scalar"
    ? nonNull[0].type
    : undefined;
}
