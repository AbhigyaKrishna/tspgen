import { constantCase, pascal } from "@abhigyakrishna/tspgen-core";
import type { GoNaming } from "./options.js";

const GO_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GO_KEYWORDS = new Set([
  "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func", "go", "goto",
  "if", "import", "interface", "map", "package", "range", "return", "select", "struct", "switch", "type", "var",
]);

/** Go's exported identifier form, shared by models and HTTP targets. */
export function goName(name: string, naming: GoNaming = {}): string {
  let result = pascal(name).replace(/[^A-Za-z0-9_]/g, "");
  if (naming.initialisms?.length) {
    const initials = new Set(naming.initialisms);
    result = (result.match(/[A-Z]+(?=[A-Z][a-z]|[0-9]|$)|[A-Z]?[a-z]+|[0-9]+|_+/g) ?? [result])
      .map((word) => initials.has(word.toUpperCase()) ? word.toUpperCase() : word).join("");
  }
  return /^[A-Za-z_]/.test(result) ? result : `X${result}`;
}

export function validPackage(name: string): boolean {
  return GO_IDENT.test(name) && !GO_KEYWORDS.has(name);
}

export function validModule(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.endsWith("/") &&
    path.split("/").every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) && part !== "." && part !== "..");
}

/** A local placeholder version that respects semantic import version suffixes. */
export function localModuleVersion(path: string): string {
  const suffix = path.match(/\/v([0-9]+)$/);
  return suffix && Number(suffix[1]) >= 2 ? `v${suffix[1]}.0.0` : "v0.0.0";
}

export function fileName(name: string): string {
  return constantCase(name).toLowerCase();
}
