import type { TypeIR, TypeRef } from "@abhigyakrishna/tspgen-core";

/** Reject incompatible JSON kinds before invoking serializers (notably enum decoders). */
export function jsonShape(ref: TypeRef, types: ReadonlyMap<string, TypeIR>, visited = new Set<string>()): string {
  switch (ref.kind) {
    case "literal":
      return ref.value === null ? "element is JsonNull" : primitive(typeof ref.value);
    case "array":
      return ref.delimiter === undefined ? "element is JsonArray" : primitive("string");
    case "map":
      return "element is JsonObject";
    case "nullable":
      return `element is JsonNull || (${jsonShape(ref.of, types, visited)})`;
    case "scalar": {
      if (ref.wireEncoding) return primitive(ref.wireEncoding.type === "string" ? "string" : "number");
      if (ref.encoding === "string") return primitive("string");
      if (ref.name === "boolean") return primitive("boolean");
      return primitive(/^(u?int|integer|safeint|float|numeric)/.test(ref.name) ? "number" : "string");
    }
    case "named": {
      if (visited.has(ref.id)) return "true";
      const next = new Set(visited).add(ref.id);
      const type = types.get(ref.id);
      if (type?.kind === "model") return type.tuple ? "element is JsonArray" : "element is JsonObject";
      if (type?.kind === "enum") return [...new Set(type.members.map((member) => typeof member.value))].map((kind) => `(${primitive(kind)})`).join(" || ") || "false";
      if (type?.kind === "union") return type.variants.map((v) => `(${jsonShape(v.type, types, next)})`).join(" || ") || "false";
      return "true";
    }
    default:
      return "true";
  }
}

function primitive(kind: string): string {
  if (kind === "string") return "element is JsonPrimitive && element.isString";
  if (kind === "boolean") return "element is JsonPrimitive && !element.isString && element.booleanOrNull != null";
  return "element is JsonPrimitive && !element.isString && element.doubleOrNull != null";
}
