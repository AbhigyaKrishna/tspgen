import { relative, sep } from "node:path";

/** Relative filesystem path with portable separators; empty when the directories are equal. */
export function relativeOutputPath(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

/** Prefix a local module path with ./ unless it already starts with a dot. */
export function ensureRelativePrefix(path: string): string {
  return path.startsWith(".") ? path : `./${path}`;
}
