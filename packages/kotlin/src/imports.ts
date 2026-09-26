import { kotlinxImports } from "./serialization/kotlinx.js";
import type { KtApiDecl, KtDecl } from "./transform/model.js";

/** Dedupe, drop same-package imports, sort. */
export function organizeImports(imports: readonly string[], pkg: string): string[] {
  return [...new Set(imports)].filter((i) => i.slice(0, i.lastIndexOf(".")) !== pkg).sort();
}

function simpleName(fqn: string): string {
  return fqn.slice(fqn.lastIndexOf(".") + 1);
}

/**
 * Imports for a file plus the FQNs that must be written fully qualified because another import
 * already uses their simple name. `preferred` imports (used by simple name in templates) win.
 */
export function resolveImports(
  candidates: readonly string[],
  pkg: string,
  preferred: readonly string[] = [],
): { imports: string[]; qualified: string[] } {
  const unique = organizeImports(candidates, pkg);
  // Preferred imports first, then in order of first use, so the first-used type keeps its short name.
  const firstUse = (fqn: string) => candidates.indexOf(fqn);
  const ordered = [...unique].sort(
    (a, b) => Number(preferred.includes(b)) - Number(preferred.includes(a)) || firstUse(a) - firstUse(b),
  );
  const taken = new Set<string>();
  const qualified: string[] = [];
  for (const fqn of ordered) {
    const name = simpleName(fqn);
    if (taken.has(name)) qualified.push(fqn);
    else taken.add(name);
  }
  return { imports: unique.filter((i) => !qualified.includes(i)), qualified };
}

/** Replace simple names of `fqns` in a Kotlin type expression with the fully-qualified names. */
export function qualifyText(text: string, fqns: readonly string[]): string {
  return fqns.reduce(
    (acc, fqn) => acc.replace(new RegExp(`(?<![\\w.])${simpleName(fqn)}\\b`, "g"), fqn),
    text,
  );
}

function declImportCandidates(decl: KtDecl): string[] {
  const typeImports =
    decl.kind === "typealias"
      ? decl.target.imports
      : decl.kind === "enum"
        ? []
        : [...decl.properties.flatMap((p) => p.type.imports), ...decl.implements];
  return [...typeImports, ...decl.imports, ...kotlinxImports(decl)];
}

/** Imports for a declaration file and the FQNs it must write qualified (see resolveImports). */
export function resolveDeclImports(decl: KtDecl): { imports: string[]; qualified: string[] } {
  return resolveImports(declImportCandidates(decl), decl.package, kotlinxImports(decl));
}

export function declImports(decl: KtDecl): string[] {
  return resolveDeclImports(decl).imports;
}

/** Copy of `decl` whose type texts use fully-qualified names for `qualified` imports. */
export function qualifyDecl(decl: KtDecl, qualified: readonly string[]): KtDecl {
  if (qualified.length === 0) return decl;
  const fix = <T extends { text: string; imports: string[] }>(type: T): T => {
    const hits = qualified.filter((q) => type.imports.includes(q));
    return hits.length > 0 ? { ...type, text: qualifyText(type.text, hits) } : type;
  };
  switch (decl.kind) {
    case "typealias":
      return { ...decl, target: fix(decl.target) };
    case "enum":
      return decl;
    default:
      return { ...decl, properties: decl.properties.map((p) => ({ ...p, type: fix(p.type) })) } as KtDecl;
  }
}

export function apiDeclImports(decl: KtApiDecl): string[] {
  switch (decl.kind) {
    case "result":
      return organizeImports(
        decl.variants.flatMap((v) => [...(v.body?.imports ?? []), ...v.headers.flatMap((h) => h.type.imports)]),
        decl.package,
      );
    case "exception":
      return organizeImports(decl.body.imports, decl.package);
    case "api-exception":
      return [];
  }
}
