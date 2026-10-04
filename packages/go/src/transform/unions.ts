import {
  declarationScopes, resolveMeta,
  type ApiIR, type ModelIR, type TypeRef, type UnionIR,
} from "@abhigyakrishna/tspgen-core";
import { NoTarget, type Program } from "@typespec/compiler";
import { reportDiagnostic } from "../lib.js";
import { goName } from "../naming.js";
import type { GoOptions } from "../options.js";
import { nullShape } from "../validation.js";
import { unsupported } from "./diagnostics.js";
import type { GoUnion, GoUnionTag, GoUnionVariant } from "./model.js";
import { goType, goTypeName, isEnumUnion, pointer, typeIndex } from "./type-map.js";

type ReserveName = (name: string, owner: string) => void;
type Discriminated = ModelIR & { discriminator: NonNullable<ModelIR["discriminator"]> };
type UnionSource = UnionIR | Discriminated;
/** A variant and the TypeSpec identifier diagnostics name it by. */
type Labeled = { label: string; variant: GoUnionVariant };

export function isDiscriminated(model: ModelIR): model is Discriminated {
  return model.discriminator !== undefined;
}

/** Members every union struct declares besides its variant fields. */
const UNION_MEMBERS = ["MarshalJSON", "UnmarshalJSON", "MarshalText", "UnmarshalText", "Validate"];

/** Discriminator values per derived model, in mapping order. */
function hierarchyValues(model: Discriminated): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  for (const [value, id] of Object.entries(model.discriminator.mapping)) byId.set(id, [...(byId.get(id) ?? []), value]);
  return byId;
}

/** The JSON name of a `@discriminator` property, declared on the base model or its derived models. */
function discriminatorWireName(model: Discriminated, api: ApiIR): string {
  const types = typeIndex(api);
  for (const id of [model.id, ...Object.values(model.discriminator.mapping)]) {
    const candidate = types.get(id);
    const property = candidate?.kind === "model"
      ? candidate.properties.find((item) => item.name === model.discriminator.property)
      : undefined;
    if (property) return property.wireName;
  }
  return model.discriminator.property;
}

/** Discriminators each variant model writes, keyed by model id; conflicting values are diagnosed. */
export function discriminatorTags(api: ApiIR, program: Program): Map<string, GoUnionTag[]> {
  const types = typeIndex(api);
  const tags = new Map<string, GoUnionTag[]>();
  const add = (id: string, property: string, values: string[], name?: string) => {
    if (types.get(id)?.kind !== "model") return;
    const list = tags.get(id) ?? [];
    const existing = list.find((tag) => tag.property === property);
    if (!existing) {
      list.push({ property, values, ...(name ? { name } : {}) });
      tags.set(id, list);
    } else if (existing.values.join("\u0000") !== values.join("\u0000")) {
      unsupported(program, id, `conflicting values for discriminator ${JSON.stringify(property)}`);
    }
  };
  for (const source of api.types) {
    if (source.kind === "model" && isDiscriminated(source)) {
      const property = discriminatorWireName(source, api);
      for (const [id, values] of hierarchyValues(source)) add(id, property, values, source.discriminator.property);
    } else if (source.kind === "union" && source.discriminator?.envelope === "none") {
      for (const variant of source.variants) {
        if (variant.type.kind !== "named" || !variant.name) continue;
        const target = types.get(variant.type.id);
        if (target?.kind === "model" && isDiscriminated(target)) {
          unsupported(program, target.id, "nested discriminated models are not supported yet");
          continue;
        }
        add(variant.type.id, source.discriminator.property, [variant.name]);
      }
    }
  }
  return tags;
}

function jsonKind(ref: TypeRef, api: ApiIR, options: GoOptions): string {
  switch (ref.kind) {
    case "array": return "[";
    case "map": return "{";
    case "nullable": return jsonKind(ref.of, api, options);
    case "literal": return typeof ref.value === "string" ? "\"" : typeof ref.value === "boolean" ? "t" : "0";
    case "scalar": {
      const text = goType({ ...ref, custom: undefined }, api, "", undefined, "", options).text;
      if (text === "bool") return "t";
      return /^(?:u?int\d*|float\d+|json\.Number)$/.test(text) ? "0" : "\"";
    }
    case "named": {
      const decl = typeIndex(api).get(ref.id);
      if (decl?.kind === "model") return "{";
      if (decl?.kind === "enum") return typeof decl.members[0]?.value === "string" ? "\"" : "0";
      return "*";
    }
    default: return "*";
  }
}

/** Parameter text rank and exact texts (see `GoUnionVariant.text`); rank 0 cannot be a parameter. */
function textRank(ref: TypeRef, api: ApiIR, options: GoOptions): { text: number; members: string[] } {
  switch (ref.kind) {
    case "literal": return { text: 1, members: [String(ref.value)] };
    case "scalar": {
      // Rank by the TypeSpec std root: `integer` stays an integer as `json.Number`, decimal a number as a string.
      if (ref.name === "bytes") return { text: 0, members: [] };
      if (ref.name === "boolean") return { text: 2, members: [] };
      if (/^(?:integer|safeint|u?int(?:8|16|32|64))$/.test(ref.name)) return { text: 3, members: [] };
      if (/^(?:float(?:32|64)?|decimal(?:128)?|numeric)$/.test(ref.name)) return { text: 4, members: [] };
      const text = goType({ ...ref, custom: undefined }, api, "", undefined, "", options).text;
      if (text === "[]byte" || text === "any") return { text: 0, members: [] };
      return { text: text === "string" ? 6 : 5, members: [] };
    }
    case "named": {
      const decl = typeIndex(api).get(ref.id);
      if (decl?.kind === "enum") return { text: 1, members: decl.members.map((member) => String(member.value)) };
      if (decl && isEnumUnion(decl) && decl.kind === "union") {
        // Open enums (literals widened by string) accept any text.
        if (decl.variants.some((variant) => variant.type.kind === "scalar")) return { text: 6, members: [] };
        return { text: 1, members: decl.variants.flatMap((variant) => variant.type.kind === "literal" ? [String(variant.type.value)] : []) };
      }
      return { text: 0, members: [] };
    }
    default: return { text: 0, members: [] };
  }
}

function variantName(ref: TypeRef, api: ApiIR, options: GoOptions): string {
  switch (ref.kind) {
    case "named": {
      const decl = typeIndex(api).get(ref.id);
      return decl ? goTypeName(decl, options) : "Value";
    }
    case "scalar": return goName(ref.custom?.name ?? ref.name, options.naming);
    case "array": return `${variantName(ref.of, api, options)}Array`;
    case "map": return `${variantName(ref.of, api, options)}Map`;
    case "nullable": return variantName(ref.of, api, options);
    case "literal":
      return typeof ref.value === "string" && ref.value
        ? goName(ref.value, options.naming)
        : goName(`literal ${String(ref.value)}`, options.naming);
    default: return "Any";
  }
}

function unionVariant(
  ref: TypeRef, name: string, values: string[], where: string,
  api: ApiIR, program: Program, options: GoOptions, docs?: string,
): GoUnionVariant {
  const resolved = goType(ref, api, "", program, where, options);
  const bytes = ref.kind === "scalar" && goType({ ...ref, custom: undefined }, api, "", undefined, "", options).text === "[]byte";
  const nilable = ref.kind === "array" || ref.kind === "map" || bytes;
  return {
    name, values,
    type: nilable ? resolved : pointer(resolved),
    kind: jsonKind(ref, api, options),
    ...textRank(ref, api, options),
    ...(ref.kind === "literal" ? { literal: JSON.stringify(ref.value) } : {}),
    shape: nullShape(ref, api),
    ...(docs ? { docs } : {}),
  };
}

function hierarchyVariants(model: Discriminated, api: ApiIR, program: Program, options: GoOptions): Labeled[] {
  const types = typeIndex(api);
  return [...hierarchyValues(model)].map(([id, values]) => {
    const derived = types.get(id);
    if (derived?.kind === "model" && derived.discriminator) {
      unsupported(program, id, "nested discriminated models are not supported yet");
    }
    const name = derived ? goTypeName(derived, options) : goName(values[0], options.naming);
    const label = `${model.id}.${values[0]}`;
    return { label, variant: unionVariant({ kind: "named", id }, name, values, label, api, program, options) };
  });
}

function declaredVariants(source: UnionIR, api: ApiIR, program: Program, options: GoOptions): Labeled[] {
  return source.variants.map((variant, index) => {
    const name = variant.name ? goName(variant.name, options.naming) : variantName(variant.type, api, options);
    const values = source.discriminator && variant.name ? [variant.name] : [];
    const label = `${source.id}.${variant.name ?? index}`;
    return { label, variant: unionVariant(variant.type, name, values, label, api, program, options, variant.docs) };
  });
}

export function unionDeclaration(
  source: UnionSource, api: ApiIR, program: Program, options: GoOptions, reserve: ReserveName,
): GoUnion {
  const name = goTypeName(source, options);
  const meta = resolveMeta(declarationScopes(source.decorators, source.namespaceDecorators), "go");
  const validation = options.features?.at("validation", meta, source.kind) ?? options.validation;
  const unknown = options.features?.at("enum-unknown", meta, source.kind) ?? options.enumUnknown;
  const labeled = source.kind === "model"
    ? hierarchyVariants(source, api, program, options)
    : declaredVariants(source, api, program, options);
  if (!labeled.length) unsupported(program, source.id, "unions need at least one variant");
  const owners = new Map(UNION_MEMBERS.map((member) => [member, `${source.id} method`]));
  if (unknown) owners.set("Unknown", `${source.id} unknown payload`);
  for (const { label, variant } of labeled) {
    const first = owners.get(variant.name);
    if (first) {
      reportDiagnostic(program, { code: "duplicate-name", format: { name: variant.name, first, second: label }, target: NoTarget });
      continue;
    }
    owners.set(variant.name, label);
    reserve(`New${name}${variant.name}`, `${label} constructor`);
  }
  const variants = labeled.map((item) => item.variant);
  const discriminator = source.kind === "model"
    ? { property: discriminatorWireName(source, api), envelope: "none" as const, envelopeProperty: "" }
    : source.discriminator;
  return {
    kind: "union", id: source.id, name, namespace: source.namespace.join("."), variants, unknown, validation,
    text: !discriminator && variants.length > 0 && variants.every((variant) => variant.text > 0),
    ...(discriminator ? { discriminator } : {}),
    ...(source.docs ? { docs: source.docs } : {}),
  };
}
