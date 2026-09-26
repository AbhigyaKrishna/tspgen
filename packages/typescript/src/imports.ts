import { posix } from "node:path";

/** An imported name; `from` is an output-relative path without extension, or a module when `external`. */
export interface TsImport {
  name: string;
  from: string;
  typeOnly: boolean;
  external?: boolean;
}

export function relativeSpecifier(fromFile: string, toFile: string, extension: string): string {
  const rel = posix.relative(posix.dirname(fromFile), toFile);
  return `${rel.startsWith(".") ? rel : `./${rel}`}${extension}`;
}

/** Render import statements for `file`: external modules first, then relative; values before types. */
export function renderImports(file: string, imports: readonly TsImport[], extension: string): string[] {
  const groups = new Map<string, { external: boolean; values: Set<string>; types: Set<string> }>();
  for (const i of imports) {
    if (!i.external && i.from === file) continue;
    const spec = i.external ? i.from : relativeSpecifier(file, i.from, extension);
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
