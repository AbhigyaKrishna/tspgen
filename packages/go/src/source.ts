import type { FileSpec } from "@abhigyakrishna/tspgen-core";
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
