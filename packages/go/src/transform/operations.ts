import { isFixedStatus, type OperationIR } from "@abhigyakrishna/tspgen-core";
import { NoTarget, type Program } from "@typespec/compiler";
import { reportDiagnostic } from "../lib.js";
import { goName } from "../naming.js";
import type { GoIR, GoOperation } from "./model.js";
import { goType } from "./type-map.js";

function validateOperationTypes(op: OperationIR, success: GoOperation["success"], program: Program, ir: GoIR): void {
  for (const param of op.params) goType(param.type, ir.api, "", program, `${op.id}.${param.name}`, ir.options);
  if (op.body) goType(op.body.type, ir.api, "", program, `${op.id} body`, ir.options);
  if (success.body) goType(success.body.type, ir.api, "", program, `${op.id} response`, ir.options);
  const fields = new Set<string>();
  for (const param of op.params) {
    const field = goName(`${param.location} ${param.name}`, ir.options.naming);
    if (fields.has(field)) {
      reportDiagnostic(program, {
        code: "duplicate-name",
        format: { name: field, first: `${op.id} parameter`, second: `${op.id}.${param.name}` },
        target: NoTarget,
      });
    }
    fields.add(field);
  }
}

/** The JSON-only HTTP subset shared by Go client and server targets. */
export function goOperations(program: Program, ir: GoIR): GoOperation[] {
  const result: GoOperation[] = [];
  const names = new Map<string, string>();
  const grouped = ir.api.services.flatMap((service) => service.groups);
  for (const group of grouped) {
    for (const op of group.operations) {
      const sourceName = ir.options.naming["operation-prefix"] === "none" ? op.name : `${group.name} ${op.name}`;
      const name = goName(sourceName, ir.options.naming);
      const first = names.get(name);
      if (first) {
        reportDiagnostic(program, { code: "duplicate-name", format: { name, first, second: op.id }, target: NoTarget });
      } else {
        names.set(name, op.id);
      }
      const reason = unsupportedOperation(op);
      if (reason) {
        reportDiagnostic(program, { code: "unsupported-operation", format: { id: op.id, reason }, target: NoTarget });
        continue;
      }
      const success = op.responses.find((response) => !response.isError)!;
      validateOperationTypes(op, success, program, ir);
      result.push({
        id: op.id, name, verb: op.verb.toUpperCase(), path: op.path, params: op.params,
        ...(op.body ? { body: {
          type: op.body.type, optional: op.body.optional,
          ...(op.body.constraints ? { constraints: op.body.constraints } : {}),
        } } : {}),
        success, status: success.statusCodes as number,
        group: group.id, namespace: group.namespace.join("."),
        errors: op.responses.filter((response) => response.isError),
        ...(op.docs ? { docs: op.docs } : {}),
      });
    }
  }
  return result;
}

function unsupportedOperation(op: OperationIR): string | undefined {
  if (op.auth && op.auth.options.some((option) => option.length > 0)) return "authentication is not supported yet";
  const success = op.responses.filter((response) => !response.isError);
  if (success.length !== 1 || !isFixedStatus(success[0].statusCodes)) {
    return "exactly one fixed-status success response is required";
  }
  if (op.body && (op.body.kind !== "single" || !op.body.contentTypes.some((contentType) => contentType.includes("json")))) {
    return "only JSON request bodies are supported";
  }
  if (success[0].body && (success[0].body.stream || !success[0].body.contentTypes.some((contentType) => contentType.includes("json")))) {
    return "only JSON response bodies are supported";
  }
  if (success[0].headers.length) return "response headers are not supported yet";
  if (op.params.some((param) =>
    param.location === "cookie" || ["array", "map", "file"].includes(param.type.kind),
  )) {
    return "cookies, collection parameters, and files are not supported yet";
  }
  if (op.params.some((param) => ["named", "nullable", "unknown"].includes(param.type.kind))) {
    return "only scalar path, query, and header parameters are supported";
  }
  if (op.params.some((param) => param.type.kind === "scalar" && param.type.name === "bytes")) {
    return "byte parameters are not supported yet";
  }
  if (op.params.some((param) => param.location === "path" && !op.path.includes(`{${param.wireName}}`))) {
    return "path parameters must appear as simple {name} placeholders in the route";
  }
  return undefined;
}
