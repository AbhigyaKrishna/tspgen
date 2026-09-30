export const goVersionSchema = {
  type: "string",
  pattern: "^1\\.[0-9]+(?:\\.[0-9]+)?$",
  default: "1.22",
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
