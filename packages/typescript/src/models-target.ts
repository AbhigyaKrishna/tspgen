import type { FileSpec, Target } from "@abhigyakrishna/tspgen-core";
import { relativeSpecifier, renderImports, type TsImport } from "./imports.js";
import type { TsDecl, TsIR } from "./transform/model.js";

const Z: TsImport = { name: "z", from: "zod", typeOnly: false, external: true };

function declImports(decl: TsDecl, zod: boolean): TsImport[] {
  const uses =
    decl.kind === "interface" ? decl.properties.map((p) => p.type) : decl.kind === "alias" ? [decl.type] : [];
  const extendsImports = decl.kind === "interface" ? decl.extends.flatMap((e) => e.imports) : [];
  return [
    ...uses.flatMap((u) => u.imports),
    ...extendsImports,
    ...(zod ? [Z, ...uses.flatMap((u) => u.schemaImports)] : []),
  ];
}

function barrel(file: string, members: string[], ext: string): FileSpec {
  return {
    path: `${file}.ts`,
    template: "ts/file",
    data: {
      imports: [],
      body: "ts/barrel",
      exports: members.map((m) => relativeSpecifier(file, m, ext)).sort(),
    },
  };
}

/** Declarations grouped by namespace, in first-appearance order. */
function sections(decls: TsDecl[]): { title: string; decls: TsDecl[] }[] {
  const byNamespace = new Map<string, TsDecl[]>();
  for (const decl of decls) {
    const key = decl.namespace.join(".");
    byNamespace.set(key, [...(byNamespace.get(key) ?? []), decl]);
  }
  return [...byNamespace].map(([title, members]) => ({ title, decls: members }));
}

/**
 * Built-in target: models/ (one file per declaration + barrel) or types.ts (single-file layout), and api/
 * (errors, results, barrel).
 */
export const tsModelsTarget: Target<TsIR> = {
  name: "typescript-models",
  kind: "models",
  language: "typescript",
  files: (ir) => {
    const ext = ir.importExtension;
    const files: FileSpec[] = [];
    if (ir.layout === "single-file") {
      if (ir.declarations.length > 0) {
        files.push({
          path: "types.ts",
          template: "ts/file",
          data: {
            imports: renderImports("types", ir.declarations.flatMap((d) => declImports(d, ir.zod)), ext),
            body: "ts/types",
            sections: sections(ir.declarations),
            zod: ir.zod,
          },
        });
      }
    } else {
      for (const decl of ir.declarations) {
        files.push({
          path: `${decl.file}.ts`,
          template: "ts/file",
          data: {
            imports: renderImports(decl.file, declImports(decl, ir.zod), ext),
            body: `ts/model/${decl.kind}`,
            decl,
            zod: ir.zod,
          },
        });
      }
      if (ir.declarations.length > 0) {
        files.push(barrel("models/index", ir.declarations.map((d) => d.file), ext));
      }
    }
    if (!ir.apiActive) return files;
    files.push({
      path: "api/errors.ts",
      template: "ts/file",
      data: {
        imports: renderImports("api/errors", ir.errorClasses.flatMap((e) => e.body.imports), ext),
        body: "ts/api/errors",
        errors: ir.errorClasses,
      },
    });
    const apiFiles = ["api/errors"];
    if (ir.results.length > 0) {
      const imports = ir.results.flatMap((r) =>
        r.variants.flatMap((v) => [...(v.body?.imports ?? []), ...v.headers.flatMap((h) => h.type.imports)]),
      );
      files.push({
        path: "api/results.ts",
        template: "ts/file",
        data: { imports: renderImports("api/results", imports, ext), body: "ts/api/results", results: ir.results },
      });
      apiFiles.push("api/results");
    }
    files.push(barrel("api/index", apiFiles, ext));
    return files;
  },
};
