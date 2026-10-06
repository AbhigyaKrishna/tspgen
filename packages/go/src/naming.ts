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
  // Exported identifiers must start with an uppercase letter (this also avoids the blank identifier "_").
  return /^[A-Z]/.test(result) ? result : `X${result}`;
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

// go/build treats *_test, *_GOOS and *_GOARCH file names as test-only or platform-constrained.
const GO_FILE_CONSTRAINTS = new Set([
  "test",
  "aix", "android", "darwin", "dragonfly", "freebsd", "hurd", "illumos", "ios", "js", "linux", "nacl", "netbsd",
  "openbsd", "plan9", "solaris", "wasip1", "windows", "zos",
  "386", "amd64", "amd64p32", "arm", "armbe", "arm64", "arm64be", "loong64", "mips", "mipsle", "mips64", "mips64le",
  "mips64p32", "mips64p32le", "ppc", "ppc64", "ppc64le", "riscv", "riscv64", "s390", "s390x", "sparc", "sparc64", "wasm",
]);

/**
 * A source file stem for a generated declaration group that every build includes. Stems that the Go toolchain
 * would constrain, or that collide with the given generated files, get a `_types` suffix.
 */
export function sourceFileName(name: string, reserved: readonly string[] = []): string {
  const stem = fileName(name) || "types";
  const suffix = stem.includes("_") ? stem.slice(stem.lastIndexOf("_") + 1) : undefined;
  const constrained = suffix !== undefined && GO_FILE_CONSTRAINTS.has(suffix);
  return constrained || reserved.includes(stem) ? `${stem}_types` : stem;
}

// encoding/json silently ignores tag names with other characters and falls back to the Go field name.
const JSON_TAG_PUNCTUATION = "!#$%&()*+-./:;<=>?@[]^_{|}~ ";

export function validJSONTagName(name: string): boolean {
  return name.length > 0 && [...name].every((char) => JSON_TAG_PUNCTUATION.includes(char) || /^[\p{L}\p{Nd}]$/u.test(char));
}
