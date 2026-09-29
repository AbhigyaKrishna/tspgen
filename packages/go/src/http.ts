import type { FileSpec, ResponseIR, TargetContext, TypeRef } from "@abhigyakrishna/tspgen-core";
import { NoTarget } from "@typespec/compiler";
import { relative, resolve, sep } from "node:path";
import { reportDiagnostic } from "./lib.js";
import { constraintsLiteral, nullShape } from "./models-target.js";
import { effectiveGoVersion, type GoHTTPOptions } from "./options.js";
import { fileName, goName, goType, typeUse, validModule, validPackage, type GoIR, type GoOperation, type GoType } from "./transform.js";

export function optionalType(type: GoType, optional: boolean): string {
  return optional && !type.pointer && type.text !== "any" ? `*${type.text}` : type.text;
}

export function parameterField(param: GoOperation["params"][number], ir: GoIR): string {
  return goName(`${param.location} ${param.name}`, ir.options.naming);
}

export function requestName(op: GoOperation, options: GoHTTPOptions): string { return `${op.name}${options["request-suffix"] ?? "Request"}`; }

export function requestDeclaration(op: GoOperation, ir: GoIR, options: GoHTTPOptions): string {
  const fields = op.params.map((p) => `\t${parameterField(p, ir)} ${optionalType(typeUse(p.type, ir), p.optional)}`);
  if (op.body) fields.push(`\tBody ${optionalType(typeUse(op.body.type, ir), op.body.optional)}`);
  return [`type ${requestName(op, options)} struct {`, ...fields, "}"].join("\n");
}

export function operationImports(ops: GoOperation[], ir: GoIR): string[] {
  return [...new Set(ops.flatMap((op) => [
    ...op.params.map((p) => typeUse(p.type, ir)), ...(op.body ? [typeUse(op.body.type, ir)] : []),
    ...(op.success.body ? [typeUse(op.success.body.type, ir)] : []),
  ]).flatMap((type) => type.imports ?? []))];
}

export function goFile(path: string, body: string, imports: string[], ir: GoIR, packageName: string): FileSpec {
  const names = [...new Set(imports)].sort();
  const header = names.length ? `import (\n${names.map((name) => `\t${name === ir.module ? "models " : ""}${JSON.stringify(name)}`).join("\n")}\n)\n\n` : "";
  return { path, template: "go/file", data: { package: packageName, body: header + body } };
}

export interface OperationUnit { name: string; file: string; operations: GoOperation[] }
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
  if (!validModule(options.module)) reportDiagnostic(ctx.program, { code: "invalid-module", format: { name: String(options.module) }, target: NoTarget });
  if (!validPackage(packageName)) reportDiagnostic(ctx.program, { code: "invalid-package", format: { name: packageName }, target: NoTarget });
  if (options.module === ir.module) throw new Error("The HTTP module must differ from the models module.");
  const version = effectiveGoVersion(ir.options.goVersion, options, minimum);
  if (ctx.program.hasError()) throw new Error("Cannot generate a Go HTTP target; see the reported diagnostics.");
  return version;
}

export function modelsDirectory(ctx: TargetContext, kind: "client" | "server"): string {
  const path = relative(resolve(ctx.outputDir, kind), resolve(ctx.modelsOutputDir, "models")).split(sep).join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

export function parameterCheck(op: GoOperation, ir: GoIR): string[] {
  return op.params.map((p) => `if err := models.CheckProperty(${JSON.stringify(p.wireName)}, request.${parameterField(p, ir)}, ${p.optional}, ${JSON.stringify(nullShape(p.type))}, ${constraintsLiteral(p.constraints, p.type)}); err != nil`);
}

export function bodyCheck(op: GoOperation, ir: GoIR): string {
  const body = op.body!;
  return `if err := models.CheckProperty("body", request.Body, ${body.optional}, ${JSON.stringify(nullShape(body.type))}, ${constraintsLiteral(body.constraints, body.type)}); err != nil`;
}

export interface TypedHTTPError { name: string; response: ResponseIR; body?: TypeRef }
export function typedErrors(op: GoOperation, ir: GoIR, ctx: TargetContext): TypedHTTPError[] {
  return op.errors.map((response) => {
    if (response.headers.length || response.body?.stream) throw new Error(`Typed Go error ${op.id} cannot represent response headers or streams.`);
    const code = response.statusCodes;
    const suffix = typeof code === "number" ? String(code) : code === "default" ? "Default" : `${code.start}To${code.end}`;
    if (response.body) {
      if (!response.body.contentTypes.some((c) => c.includes("json"))) throw new Error(`Typed Go error ${op.id} ${suffix} requires a JSON body.`);
      goType(response.body.type, ir.api, "models.", ctx.program, `${op.id} error`, ir.options);
    }
    return { name: `${op.name}${suffix}Error`, response, ...(response.body ? { body: response.body.type } : {}) };
  });
}

export function typedErrorDeclaration(error: TypedHTTPError, ir: GoIR, client: boolean): string {
  const fixed = typeof error.response.statusCodes === "number" ? error.response.statusCodes : 500;
  const fields = ["\tStatusCode int", ...(error.body ? [`\tBody ${typeUse(error.body, ir).text}`] : []), ...(client ? ["\tCause *HTTPError"] : [])];
  return [
    `type ${error.name} struct {`, ...fields, "}", "",
    `func (e *${error.name}) HTTPStatus() int { if e.StatusCode != 0 { return e.StatusCode }; return ${fixed} }`,
    `func (e *${error.name}) HTTPBody() any { return ${error.body ? "e.Body" : "nil"} }`,
    `func (e *${error.name}) Error() string { return fmt.Sprintf("HTTP %d", e.HTTPStatus()) }`,
    ...(client ? [`func (e *${error.name}) Unwrap() error { if e.Cause == nil { return nil }; return e.Cause }`] : []),
  ].join("\n");
}

export function matchesStatus(error: TypedHTTPError, field: string): string {
  const code = error.response.statusCodes;
  return typeof code === "number" ? `${field} == ${code}` : code === "default" ? "true" : `${field} >= ${code.start} && ${field} <= ${code.end}`;
}
