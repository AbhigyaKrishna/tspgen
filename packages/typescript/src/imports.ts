import { posix, relative, sep } from "node:path";

/** An imported name; `from` is an output-relative path without extension, or a module when `external`. */
export interface TsImport {
  name: string;
  from: string;
  typeOnly: boolean;
  external?: boolean;
  /** `"models"`: `from` is relative to the models output dir, which a target may write elsewhere (see `rebase`). */
  root?: "models";
}

export function relativeSpecifier(fromFile: string, toFile: string, extension: string): string {
  const rel = posix.relative(posix.dirname(fromFile), toFile);
  return `${rel.startsWith(".") ? rel : `./${rel}`}${extension}`;
}

/**
 * Path from a target's output dir to the models output dir ("" when they are the same), for `rebase`.
 * Both are absolute; the result uses posix separators.
 */
export function modelsPrefix(outputDir: string, modelsOutputDir: string): string {
  return relative(outputDir, modelsOutputDir).split(sep).join("/");
}

/** `from` of a models-rooted path as seen from a target whose models live at `prefix` (see `modelsPrefix`). */
export function rebase(from: string, prefix: string): string {
  return prefix ? posix.join(prefix, from) : from;
}

/**
 * Render import statements for `file`: external modules first, then relative; values before types.
 * `prefix` rebases models-rooted imports (`root: "models"`) for targets writing outside the models dir.
 */
export function renderImports(file: string, imports: readonly TsImport[], extension: string, prefix = ""): string[] {
  const groups = new Map<string, { external: boolean; values: Set<string>; types: Set<string> }>();
  for (const i of imports) {
    const from = i.root === "models" ? rebase(i.from, prefix) : i.from;
    if (!i.external && from === file) continue;
    const spec = i.external ? from : relativeSpecifier(file, from, extension);
    let group = groups.get(spec);
    if (!group) {
      group = { external: Boolean(i.external), values: new Set(), types: new Set() };
      groups.set(spec, group);
    }
    (i.typeOnly ? group.types : group.values).add(i.name);
  }
  const specs = [...groups.keys()].sort((a, b) => {
    const ea = groups.get(a)!.external;
    const eb = groups.get(b)!.external;
    return ea === eb ? a.localeCompare(b) : ea ? -1 : 1;
  });
  const lines: string[] = [];
  for (const spec of specs) {
    const { values, types } = groups.get(spec)!;
    const typeOnly = [...types].filter((t) => !values.has(t));
    if (values.size > 0) lines.push(`import { ${[...values].sort().join(", ")} } from "${spec}";`);
    if (typeOnly.length > 0) lines.push(`import type { ${typeOnly.sort().join(", ")} } from "${spec}";`);
  }
  return lines;
}
