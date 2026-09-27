import {
  getDiscriminatedUnion,
  getDiscriminator,
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
  navigateTypesInNamespace,
  NoTarget,
  resolveEncodedName,
  serializeValueAsJson,
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
import { isBody, isBodyRoot, isMetadata } from "@typespec/http";
import { reportDiagnostic } from "../lib.js";
import { pascal } from "../naming.js";
import { collectDecorators } from "./decorators.js";
import { docInfo } from "./docs.js";
import type { ConstraintsIR, EnumIR, ModelIR, PropertyIR, TypeIR, TypeRef, UnionIR } from "./types.js";

const UNKNOWN: TypeRef = { kind: "unknown" };

/** Converts TypeSpec types into TypeRefs, collecting named/anonymous declarations as TypeIR. */
export class TypeCollector {
  private readonly types = new Map<string, TypeIR>();
  private readonly ids = new Map<Type, string>();
  /** Template declarations checked by `declarationGeneric` (true while being checked, for recursion). */
  private readonly genericDeclarations = new Map<Model, boolean>();

  constructor(
    private readonly program: Program,
    private readonly options: { generics: boolean } = { generics: true },
  ) {}

  getTypes(): TypeIR[] {
    return [...this.types.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Collect every declared model/enum/union in a namespace (recursively), even if unreferenced. */
  collectNamespace(ns: Namespace): void {
    navigateTypesInNamespace(ns, {
      model: (m) => {
        if (m.name && !isTemplateDeclaration(m) && !this.isCollection(m) && !this.isHttpEnvelope(m)) {
          // Partial instances inside template declarations (`Link<T>`) are not types of their own.
          if (this.mentionsTemplateParameter(m)) return;
          // A template instance that can be generic contributes its declaration, not a model of its own.
          if (!(this.options.generics && this.genericRef(m, m.name))) this.collectModel(m, m.name);
        }
      },
      enum: (e) => {
        this.collectEnum(e);
      },
      union: (u) => {
        if (u.name && !isTemplateDeclaration(u)) this.unionRef(u, u.name);
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

  private isCollection(model: Model): boolean {
    return isArrayModelType(model) || (isRecordModelType(model) && model.name === "Record");
  }

  /** Models carrying HTTP metadata/body properties describe requests/responses, not data. */
  private isHttpEnvelope(model: Model): boolean {
    return [...model.properties.values()].some(
      (p) => isMetadata(this.program, p) || isBody(this.program, p) || isBodyRoot(this.program, p),
    );
  }

  /** `generic: false` collects a template instance as its own model even when it could be generic. */
  private modelRef(model: Model, hint: string, generic = true): TypeRef {
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
    if (this.options.generics && generic) {
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
    const declaration = this.program.checker.getTypeForNode(instance.templateNode);
    if (declaration.kind !== "Model" || !isTemplateDeclaration(declaration)) return undefined;
    const types = args.filter(
      (arg): arg is Type =>
        (arg as { entityKind?: string }).entityKind === "Type" &&
        ((arg as Type).kind !== "Intrinsic" || (arg as { name?: string }).name === "unknown"),
    );
    if (types.length !== args.length || !this.expressible(instance, declaration)) return undefined;
    return this.declarationGeneric(declaration) ? { declaration, args: types } : undefined;
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
    return {
      kind: "scalar",
      name,
      custom: { id: getTypeName(scalar), name: scalar.name, decorators: collectDecorators(scalar) },
    };
  }

  private stdScalarName(scalar: Scalar): string {
    let current = scalar;
    while (current.baseScalar && !this.isStd(current)) current = current.baseScalar;
    return current.name;
  }

  private isStd(scalar: Scalar): boolean {
    return scalar.namespace !== undefined && getNamespaceFullName(scalar.namespace) === "TypeSpec";
  }

  private identify(type: Model | Union | Enum, hint: string): { id: string; name: string; namespace: string[] } {
    if (type.name) {
      const friendly = getFriendlyName(this.program, type);
      const name = friendly ?? type.name + templateArgsName(type);
      const namespace = type.namespace ? splitNamespace(getNamespaceFullName(type.namespace)) : [];
      return { id: getTypeName(type), name, namespace };
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
    this.ids.set(model, id);
    const ir: ModelIR = {
      kind: "model",
      id,
      name,
      namespace,
      ...docInfo(this.program, state ?? model),
      decorators: collectDecorators(model),
      properties: [],
    };
    if (isTemplateDeclaration(model)) ir.typeParameters = model.node!.templateParameters.map((p) => p.id.sv);
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
      type: this.ref(prop.type, `${parentName}${pascal(prop.name)}`),
      optional: prop.optional,
      ...docInfo(this.program, state),
      decorators: collectDecorators(prop),
    };
    const constraints = this.constraints(state);
    if (constraints) ir.constraints = constraints;
    if (state.defaultValue) ir.default = serializeValueAsJson(this.program, state.defaultValue, state.type);
    return ir;
  }

  private constraints(prop: ModelProperty): ConstraintsIR | undefined {
    const sources: Type[] = prop.type.kind === "Scalar" ? [prop, prop.type] : [prop];
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
    this.ids.set(e, id);
    const ir: EnumIR = {
      kind: "enum",
      id,
      name,
      namespace,
      ...docInfo(this.program, e),
      decorators: collectDecorators(e),
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
    this.ids.set(union, id);
    const ir: UnionIR = {
      kind: "union",
      id,
      name,
      namespace,
      ...docInfo(this.program, union),
      decorators: collectDecorators(union),
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
