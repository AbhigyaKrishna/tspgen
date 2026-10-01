import type { GoHTTPOptions } from "./options.js";
import { goName } from "../naming.js";
import { typeUse } from "../transform/type-map.js";
import type { GoIR, GoOperation, GoType } from "../transform/model.js";
import { renderGoDeclaration } from "../source.js";

export function optionalType(type: GoType, optional: boolean): string {
  return optional && !type.pointer && type.text !== "any" ? `*${type.text}` : type.text;
}

export function parameterField(param: GoOperation["params"][number], ir: GoIR): string {
  return goName(`${param.location} ${param.name}`, ir.options.naming);
}

export function requestName(op: GoOperation, options: GoHTTPOptions): string {
  return `${op.name}${options["request-suffix"] ?? "Request"}`;
}

export interface GoRequestDeclaration {
  name: string;
  fields: { name: string; type: string }[];
}

export function requestPlan(op: GoOperation, ir: GoIR, options: GoHTTPOptions): GoRequestDeclaration {
  const fields = op.params.map((param) => ({
    name: parameterField(param, ir),
    type: optionalType(typeUse(param.type, ir), param.optional),
  }));
  if (op.body) fields.push({ name: "Body", type: optionalType(typeUse(op.body.type, ir), op.body.optional) });
  return { name: requestName(op, options), fields };
}

export function requestDeclaration(op: GoOperation, ir: GoIR, options: GoHTTPOptions): string {
  return renderGoDeclaration("go/http/request", { request: requestPlan(op, ir, options) });
}
