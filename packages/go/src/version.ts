const GO_VERSION_PATTERN = "^1\\.[0-9]+(?:\\.[0-9]+)?$";

/** The oldest Go release generated code supports (net/http method and wildcard routing). */
export const MINIMUM_GO_VERSION = "1.22";

export const goVersionSchema = {
  type: "string",
  pattern: GO_VERSION_PATTERN,
  default: MINIMUM_GO_VERSION,
  description: "Minimum Go language/toolchain version written to go.mod (1.22 or newer). Targets inherit it, subject to their runtime minimum; generic client methods require 1.27 or newer.",
};

export function atLeastGo(version: string, minimum: string): boolean {
  const actual = version.split(".").map(Number);
  const required = minimum.split(".").map(Number);
  for (let i = 0; i < Math.max(actual.length, required.length); i++) {
    const diff = (actual[i] ?? 0) - (required[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

/** A well-formed go.mod version that is at least every given minimum. */
export function supportedGoVersion(version: string, ...minimums: string[]): boolean {
  return new RegExp(GO_VERSION_PATTERN).test(version) && minimums.every((minimum) => atLeastGo(version, minimum));
}
