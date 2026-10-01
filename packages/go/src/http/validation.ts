import type { GoIR, GoOperation } from "../transform/model.js";
import { propertyCheck, propertyCheckCall } from "../validation.js";
import { parameterField } from "./requests.js";

export function parameterChecks(op: GoOperation, ir: GoIR): string[] {
  return op.params.map((param) => propertyCheckCall(propertyCheck(
    param.wireName, `request.${parameterField(param, ir)}`, param.optional, param.type, param.constraints,
  )));
}

export function bodyCheckCall(op: GoOperation, ir?: GoIR): string {
  const body = op.body!;
  return propertyCheckCall(propertyCheck("body", "request.Body", body.optional, body.type, body.constraints, "models.", ir?.api));
}

export function parameterCheck(op: GoOperation, ir: GoIR): string[] {
  return parameterChecks(op, ir).map((call) => `if err := ${call}; err != nil`);
}

export function bodyCheck(op: GoOperation, ir: GoIR): string {
  return `if err := ${bodyCheckCall(op, ir)}; err != nil`;
}
