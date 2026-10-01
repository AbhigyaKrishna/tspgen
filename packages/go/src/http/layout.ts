import { ensureRelativePrefix, relativeOutputPath, type FileSpec, type TargetContext } from "@abhigyakrishna/tspgen-core";
import { NoTarget } from "@typespec/compiler";
import { resolve } from "node:path";
import { reportDiagnostic } from "../lib.js";
import { effectiveGoVersion, type GoHTTPOptions } from "./options.js";
import { fileName, goName, validModule, validPackage } from "../naming.js";
import { typeUse } from "../transform/type-map.js";
import type { GoIR, GoOperation } from "../transform/model.js";

export function operationImports(operations: GoOperation[], ir: GoIR): string[] {
  const types = operations.flatMap((op) => {
    const refs = op.params.map((param) => param.type);
    if (op.body) refs.push(op.body.type);
    if (op.success.body) refs.push(op.success.body.type);
    return refs.map((ref) => typeUse(ref, ir));
  });
  return [...new Set(types.flatMap((type) => type.imports ?? []))];
}

export function goFile(path: string, body: string, imports: string[], ir: GoIR, packageName: string): FileSpec {
  const names = [...new Set(imports)].sort();
  const header = names.length ? `import (\n${names.map((name) => `\t${name === ir.module ? "models " : ""}${JSON.stringify(name)}`).join("\n")}\n)\n\n` : "";
  return { path, template: "go/file", data: { package: packageName, body: header + body } };
}

export interface OperationUnit {
  name: string;
  file: string;
  operations: GoOperation[];
}

export function operationUnits(ops: GoOperation[], ir: GoIR, grouping: GoHTTPOptions["grouping"]): OperationUnit[] {
  const units = new Map<string, OperationUnit>();
  for (const op of ops) {
    const key = grouping === "per-namespace" ? op.namespace || "Global" : op.group;
    const existing = units.get(key);
    if (existing) existing.operations.push(op);
    else units.set(key, { name: goName(key, ir.options.naming), file: fileName(key), operations: [op] });
  }
  const names = new Set<string>();
  for (const unit of units.values()) {
    if (names.has(unit.name)) throw new Error(`Operation grouping produces duplicate Go group ${unit.name}.`);
    names.add(unit.name);
  }
  return [...units.values()];
}

export function checkHTTPConfiguration(ir: GoIR, ctx: TargetContext, options: GoHTTPOptions, packageName: string, minimum: string): string {
  if (!validModule(options.module)) {
    reportDiagnostic(ctx.program, { code: "invalid-module", format: { name: String(options.module) }, target: NoTarget });
  }
  if (!validPackage(packageName)) {
    reportDiagnostic(ctx.program, { code: "invalid-package", format: { name: packageName }, target: NoTarget });
  }
  if (options.module === ir.module) throw new Error("The HTTP module must differ from the models module.");
  const version = effectiveGoVersion(ir.options.goVersion, options, minimum);
  if (ctx.program.hasError()) throw new Error("Cannot generate a Go HTTP target; see the reported diagnostics.");
  return version;
}

export function modelsDirectory(ctx: TargetContext, kind: "client" | "server"): string {
  return ensureRelativePrefix(relativeOutputPath(resolve(ctx.outputDir, kind), resolve(ctx.modelsOutputDir, "models")));
}
