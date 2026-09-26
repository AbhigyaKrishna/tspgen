import type { Target } from "@specgen/emitter-core";
import { apiDeclImports, declImports } from "./imports.js";
import type { KotlinIR } from "./transform/model.js";

/** Built-in target: one Kotlin file per declaration under `models/`. */
export const modelsTarget: Target<KotlinIR> = {
  name: "kotlin-models",
  kind: "models",
  language: "kotlin",
  files: (ir) => [
    ...ir.declarations.map((decl) => ({
      path: `models/${decl.package.replaceAll(".", "/")}/${decl.name}.kt`,
      template: "kotlin/file",
      data: { package: decl.package, imports: declImports(decl), body: `kotlin/model/${decl.kind}`, decl },
    })),
    ...ir.apiDeclarations.map((decl) => ({
      path: `models/${decl.package.replaceAll(".", "/")}/${decl.name}.kt`,
      template: "kotlin/file",
      data: { package: decl.package, imports: apiDeclImports(decl), body: `kotlin/api/${decl.kind}`, decl },
    })),
  ],
};
