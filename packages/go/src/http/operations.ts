import type { TargetContext } from "@abhigyakrishna/tspgen-core";
import { bodyCheckCall, parameterChecks } from "./validation.js";
import { parameterField, requestPlan } from "./requests.js";
import { operationImports } from "./layout.js";
import { typedErrorPlan, typedErrors } from "./errors.js";
import type { GoHTTPOptions } from "../options.js";
import { typeUse, type GoIR, type GoOperation } from "../transform.js";
import { nullShape } from "../validation.js";

/** Wire types and validation shared by all HTTP transports. */
export function httpOperationPlan(op: GoOperation, ir: GoIR, ctx: TargetContext, options: GoHTTPOptions, role: "client" | "server") {
  const checks = parameterChecks(op, ir);
  const errors = options.errors === "typed" ? typedErrors(op, ir, ctx) : [];
  return {
    id: op.id,
    name: op.name,
    verb: op.verb,
    path: op.path,
    status: op.status,
    imports: operationImports([op], ir),
    docs: op.docs?.split("\n") ?? [],
    request: requestPlan(op, ir, options),
    params: op.params.map((param, index) => ({
      field: parameterField(param, ir),
      wireName: param.wireName,
      location: param.location,
      optional: param.optional,
      literal: param.type.kind === "literal",
      check: checks[index],
    })),
    body: op.body ? {
      optional: op.body.optional,
      nullable: op.body.type.kind === "nullable" || op.body.type.kind === "unknown",
      shape: nullShape(op.body.type, ir.api),
      check: bodyCheckCall(op, ir),
    } : undefined,
    responseType: op.success.body ? typeUse(op.success.body.type, ir).text : undefined,
    responseShape: op.success.body ? nullShape(op.success.body.type, ir.api) : "?_",
    errors: errors.map((error) => ({
      ...typedErrorPlan(error, ir, role),
      response: error.response,
      shape: error.body ? nullShape(error.body, ir.api) : undefined,
      imports: error.body ? typeUse(error.body, ir).imports ?? [] : [],
    })),
  };
}

export type GoHTTPOperation = ReturnType<typeof httpOperationPlan>;

/** Whether the operation's declarations mention a type from the models package. */
export function referencesModels(op: GoHTTPOperation): boolean {
  const types = [op.responseType, ...op.request.fields.map((field) => field.type), ...op.errors.map((error) => error.bodyType)];
  return types.some((type) => type?.includes("models."));
}
