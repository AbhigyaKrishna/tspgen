import { pascal } from "@tspgen/emitter-core";

const KEYWORDS = new Set([
  "as", "break", "class", "continue", "do", "else", "false", "for", "fun", "if", "in", "interface",
  "is", "null", "object", "package", "return", "super", "this", "throw", "true", "try", "typealias",
  "typeof", "val", "var", "when", "while",
]);

/** Backtick-escape Kotlin hard keywords. */
export function identifier(name: string): string {
  return KEYWORDS.has(name) ? `\`${name}\`` : name;
}

export function typeName(value: string): string {
  const name = pascal(value);
  return /^[0-9]/.test(name) ? `T${name}` : name;
}

export function camel(value: string): string {
  const name = pascal(value).replace(/^[A-Z]+(?=[A-Z][a-z]|$)|^[A-Z]/, (m) => m.toLowerCase());
  return /^[0-9]/.test(name) ? `v${name}` : name;
}

export function upperSnake(value: string): string {
  const name = value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  if (!name) return "EMPTY";
  return /^[0-9]/.test(name) ? `V_${name}` : name;
}
