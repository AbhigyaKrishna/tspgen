import { kotlinxImports } from "./serialization/kotlinx.js";
import type { KtApiDecl, KtDecl } from "./transform/model.js";

/** Dedupe, drop same-package imports, sort. */
export function organizeImports(imports: readonly string[], pkg: string): string[] {
  return [...new Set(imports)].filter((i) => i.slice(0, i.lastIndexOf(".")) !== pkg).sort();
}

export function declImports(decl: KtDecl): string[] {
  const typeImports =
    decl.kind === "typealias"
      ? decl.target.imports
      : decl.kind === "enum"
        ? []
        : [...decl.properties.flatMap((p) => p.type.imports), ...(decl.kind === "data-class" ? decl.implements : [])];
  return organizeImports([...typeImports, ...kotlinxImports(decl)], decl.package);
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
