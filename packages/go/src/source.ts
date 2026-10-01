import { TemplateEngine, type FileSpec } from "@abhigyakrishna/tspgen-core";
import { resolve } from "node:path";
import type { GoIR } from "./transform.js";

export interface GoSourceSection {
  template: string;
  data: Record<string, unknown>;
}

/** Plan source composition; the pipeline owns template resolution and formatting. */
export function goSourceFile(
  path: string,
  sections: GoSourceSection[],
  imports: string[],
  ir: GoIR,
  packageName: string,
): FileSpec {
  return {
    path,
    template: "go/file",
    data: {
      package: packageName,
      imports: [...new Set(imports)].sort().map((path) => ({ path, alias: path === ir.module ? "models" : "" })),
      sections,
    },
  };
}

// Compatibility for the public helpers that return standalone declaration strings.
const declarationEngine = new TemplateEngine([
  { name: "go", dir: resolve(import.meta.dirname, "../templates") },
]);

export function renderGoDeclaration(template: string, data: Record<string, unknown>): string {
  return declarationEngine.render(template, data).trim();
}
