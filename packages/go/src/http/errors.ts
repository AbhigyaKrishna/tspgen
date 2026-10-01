import { isDefaultStatus, isFixedStatus, type ResponseIR, type TargetContext, type TypeRef } from "@abhigyakrishna/tspgen-core";
import { goType, typeUse } from "../transform/type-map.js";
import type { GoIR, GoOperation } from "../transform/model.js";
import { renderGoDeclaration } from "../source.js";

export interface TypedHTTPError {
  name: string;
  response: ResponseIR;
  body?: TypeRef;
}

export function typedErrors(op: GoOperation, ir: GoIR, ctx: TargetContext): TypedHTTPError[] {
  return op.errors.map((response) => {
    if (response.headers.length || response.body?.stream) {
      throw new Error(`Typed Go error ${op.id} cannot represent response headers or streams.`);
    }
    const code = response.statusCodes;
    const suffix = errorStatusSuffix(code);
    if (response.body) {
      if (!response.body.contentTypes.some((contentType) => contentType.includes("json"))) {
        throw new Error(`Typed Go error ${op.id} ${suffix} requires a JSON body.`);
      }
      goType(response.body.type, ir.api, "models.", ctx.program, `${op.id} error`, ir.options);
    }
    return { name: `${op.name}${suffix}Error`, response, ...(response.body ? { body: response.body.type } : {}) };
  });
}

export function typedErrorPlan(error: TypedHTTPError, ir: GoIR, role: "client" | "server") {
  const status = error.response.statusCodes;
  return {
    name: error.name,
    fixedStatus: isFixedStatus(status) ? status : 500,
    bodyType: error.body ? typeUse(error.body, ir).text : undefined,
    client: role === "client",
  };
}

export function typedErrorDeclaration(error: TypedHTTPError, ir: GoIR, client: boolean): string {
  return renderGoDeclaration("go/http/error", { error: typedErrorPlan(error, ir, client ? "client" : "server") });
}

export function matchesStatus(error: TypedHTTPError, field: string): string {
  const code = error.response.statusCodes;
  if (isFixedStatus(code)) return `${field} == ${code}`;
  if (isDefaultStatus(code)) return "true";
  return `${field} >= ${code.start} && ${field} <= ${code.end}`;
}

function errorStatusSuffix(code: ResponseIR["statusCodes"]): string {
  if (isFixedStatus(code)) return String(code);
  if (isDefaultStatus(code)) return "Default";
  return `${code.start}To${code.end}`;
}
