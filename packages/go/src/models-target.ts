import { apiVersionConstants, type FileSpec, type Target } from "@abhigyakrishna/tspgen-core";
import { sourceFileName } from "./naming.js";
import { goOperations, type GoDecl, type GoIR } from "./transform.js";
import { modelDeclaration, modelImports } from "./models/declarations.js";
import { goSourceFile } from "./source.js";

/** File stems of the models package's own generated files. */
const RUNTIME_FILES = ["runtime", "api_version"];

function modelFile(
  ir: GoIR,
  path: string,
  declarations: GoDecl[],
  versions: ReturnType<typeof apiVersionConstants> = [],
): FileSpec {
  const sections = declarations.map((decl) => modelDeclaration(decl, ir));
  if (versions.length) sections.push({ template: "go/model/versions", data: { versions } });
  return goSourceFile(path, sections, declarations.flatMap(modelImports), ir, ir.packageName);
}

export const goModelsTarget: Target<GoIR> = {
  name: "go-models",
  kind: "models",
  language: "go",
  files: (ir, ctx): FileSpec[] => {
    if (ctx.program.hasError()) {
      // Report operation diagnostics too, so one failed run surfaces every unsupported shape.
      goOperations(ctx.program, ir);
      throw new Error("Cannot generate Go models; see the reported diagnostics.");
    }
    const files: FileSpec[] = [];
    if (ctx.features.values["go-mod"] !== false) {
      files.push({
        path: "models/go.mod",
        template: "go/mod",
        data: { module: ir.module, goVersion: ir.options.goVersion },
      });
    }
    files.push({ path: "models/runtime.go", template: "go/runtime", data: { package: ir.packageName } });
    const versions = ctx.features.values["api-version"] !== false ? apiVersionConstants(ir.api) : [];
    if (ir.options.layout === "single-file") {
      files.push(modelFile(ir, "models/models.go", ir.declarations, versions));
      return files;
    }
    const groups = new Map<string, GoDecl[]>();
    for (const decl of ir.declarations) {
      const groupName = ir.options.layout === "per-type" ? decl.name : decl.namespace || "global";
      const path = `models/${sourceFileName(groupName, RUNTIME_FILES)}.go`;
      const declarations = groups.get(path) ?? [];
      declarations.push(decl);
      groups.set(path, declarations);
    }
    for (const [path, declarations] of groups) files.push(modelFile(ir, path, declarations));
    if (versions.length) files.push(modelFile(ir, "models/api_version.go", [], versions));
    return files;
  },
};
