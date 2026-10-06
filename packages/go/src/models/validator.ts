import type { ConstraintsIR, TypeRef } from "@abhigyakrishna/tspgen-core";
import type { GoField, GoIR } from "../transform.js";
import { typeUse } from "../transform/type-map.js";

function equalityTags(values: (string | number | boolean)[]): string[] {
  // Validator decodes these sequences in tag parameters, so they cannot be matched literally.
  if (values.some((value) => /0x2C|0x7C/.test(String(value)))) return [];
  const alternatives = [...new Set(values)].map((value) =>
    `eq=${String(value).replaceAll(",", "0x2C").replaceAll("|", "0x7C")}`,
  );
  return alternatives.length ? [alternatives.join("|")] : [];
}

function numericBounds(ref: TypeRef, constraints: ConstraintsIR, ir: GoIR): string[] {
  if (ref.kind !== "scalar") return [];
  const type = typeUse({ ...ref, custom: undefined }, ir, "").text;
  // json.Number and string decimals have string kind: gte/lte would compare their lengths.
  if (!/^(?:u?int(?:8|16|32|64)|float(?:32|64))$/.test(type)) return [];
  const integer = !type.startsWith("float");
  const bits = Number(type.match(/\d+$/)![0]);
  const unsigned = type.startsWith("uint");
  const tags: string[] = [];
  for (const [tag, bound] of [["gte", constraints.minValue], ["lte", constraints.maxValue]] as const) {
    if (bound === undefined) continue;
    const limit = integer ? (tag === "gte" ? Math.ceil(bound) : Math.floor(bound)) : bound;
    if (integer) {
      const minimum = unsigned ? 0n : -(1n << BigInt(bits - 1));
      const maximum = (1n << BigInt(unsigned ? bits : bits - 1)) - 1n;
      const value = BigInt(limit);
      if (value < minimum || value > maximum) continue;
      tags.push(`${tag}=${value}`);
    } else {
      if (bits === 32 && !Number.isFinite(Math.fround(limit))) continue;
      tags.push(`${tag}=${limit}`);
    }
  }
  return tags;
}

function valueTags(ref: TypeRef, constraints: ConstraintsIR, ir: GoIR): string[] {
  const tags: string[] = [];
  for (const [tag, value] of [
    ["min", constraints.minLength ?? constraints.minItems],
    ["max", constraints.maxLength ?? constraints.maxItems],
  ] as const) {
    if (value !== undefined) tags.push(`${tag}=${value}`);
  }
  tags.push(...numericBounds(ref, constraints, ir));
  if (ref.kind === "array" || ref.kind === "map") {
    tags.push("dive", ...typeTags(ref.of, ir));
  } else if (ref.kind === "literal" && ref.value !== null) {
    tags.push(...equalityTags([ref.value]));
  } else if (ref.kind === "named") {
    const declaration = ir.declarations.find((decl) => decl.id === ref.id);
    if (declaration?.kind === "enum" && !declaration.open) {
      const values = declaration.members.map((member) => member.value);
      if (declaration.unknown) values.push("\u0000tspgen.UNKNOWN");
      tags.push(...equalityTags(values));
    }
  }
  return tags;
}

function typeTags(ref: TypeRef, ir: GoIR, constraints: ConstraintsIR = {}): string[] {
  if (ref.kind === "nullable") return ["omitnil", ...valueTags(ref.of, constraints, ir)];
  const type = typeUse(ref, ir, "");
  const requiresValue = type.pointer || ref.kind === "array" || ref.kind === "map"
    || (ref.kind === "scalar" && ref.name === "bytes");
  return [...(requiresValue ? ["required"] : []), ...valueTags(ref, constraints, ir)];
}

/** Validator tags supplement contract validation without treating zero-valued scalars as absent. */
export function validatorTag(field: GoField, ir: GoIR): string {
  if (!field.optional) return typeTags(field.ref, ir, field.constraints).join(",");
  const ref = field.ref.kind === "nullable" ? field.ref.of : field.ref;
  const skipAbsent = field.type.pointer || field.type.text === "any" ? "omitnil" : "omitempty";
  return [skipAbsent, ...valueTags(ref, field.constraints ?? {}, ir)].join(",");
}

/** Additional properties may be absent or empty; present entries get the declared map value tags. */
export function additionalValidatorTag(ref: TypeRef, ir: GoIR): string {
  return ["omitempty", ...valueTags(ref, {}, ir)].join(",");
}
