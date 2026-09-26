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

  constructor(private readonly program: Program) {}

  getTypes(): TypeIR[] {
    return [...this.types.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Collect every declared model/enum/union in a namespace (recursively), even if unreferenced. */
  collectNamespace(ns: Namespace): void {
    navigateTypesInNamespace(ns, {
      model: (m) => {
        if (m.name && !isTemplateDeclaration(m) && !this.isCollection(m) && !this.isHttpEnvelope(m)) {
          this.collectModel(m, m.name);
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

  private modelRef(model: Model, hint: string): TypeRef {
    if (isArrayModelType(model)) return { kind: "array", of: this.ref(model.indexer.value, `${hint}Item`) };
    if (isRecordModelType(model) && model.name === "Record") {
      return { kind: "map", of: this.ref(model.indexer.value, `${hint}Value`) };
    }
    return { kind: "named", id: this.collectModel(this.spreadSource(model) ?? model, hint) };
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

  private collectModel(model: Model, hint: string): string {
    const existing = this.ids.get(model);
    if (existing) return existing;
    const { id, name, namespace } = this.identify(model, hint);
    this.ids.set(model, id);
    const ir: ModelIR = {
      kind: "model",
      id,
      name,
      namespace,
      ...docInfo(this.program, model),
      decorators: collectDecorators(model),
      properties: [],
    };
    this.types.set(id, ir);
    for (const prop of model.properties.values()) {
      if (isMetadata(this.program, prop)) continue;
      ir.properties.push(this.property(prop, name));
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

  private property(prop: ModelProperty, parentName: string): PropertyIR {
    const ir: PropertyIR = {
      name: prop.name,
      wireName: resolveEncodedName(this.program, prop, "application/json"),
      type: this.ref(prop.type, `${parentName}${pascal(prop.name)}`),
      optional: prop.optional,
      ...docInfo(this.program, prop),
      decorators: collectDecorators(prop),
    };
    const constraints = this.constraints(prop);
    if (constraints) ir.constraints = constraints;
    if (prop.defaultValue) ir.default = serializeValueAsJson(this.program, prop.defaultValue, prop.type);
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
    ir.variants = variants.map((v) => {
      const variantName = typeof v.name === "string" ? v.name : undefined;
      return {
        ...(variantName ? { name: variantName } : {}),
        type: this.ref(v.type, `${name}${variantName ? pascal(variantName) : "Variant"}`),
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
