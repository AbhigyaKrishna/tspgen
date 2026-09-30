import type { TargetContext } from "@abhigyakrishna/tspgen-core";
import { httpOperationPlan, type GoHTTPOperation } from "../http/operations.js";
import type { GoServerOptions } from "../options.js";
import type { GoIR } from "../transform.js";
import type { GoServerRoute } from "./routes.js";
import type { GoServerTransport } from "./transport.js";

function parameterBinding(param: GoHTTPOperation["params"][number], route: GoServerRoute, transport: GoServerTransport) {
  const name = JSON.stringify(param.wireName);
  switch (param.location) {
    case "path": return {
      ...param,
      key: route.keys.get(param.wireName),
      raw: `r.PathValue(${name})`,
      present: "true",
    };
    case "query": return {
      ...param,
      raw: `${transport.request}.URL.Query().Get(${name})`,
      present: `${transport.request}.URL.Query().Has(${name})`,
    };
    default: return {
      ...param,
      raw: `${transport.request}.Header.Get(${name})`,
      present: `${transport.request}.Header.Values(${name}) != nil`,
    };
  }
}

export function serverOperationPlan(
  route: GoServerRoute,
  ir: GoIR,
  ctx: TargetContext,
  options: GoServerOptions,
  transport: GoServerTransport,
) {
  const plan = httpOperationPlan(route.op, ir, ctx, options, "server");
  const params = plan.params.map((param) => parameterBinding(param, route, transport));
  const parameters = [{ name: "ctx", type: "context.Context" }];
  const serviceArguments = [`${transport.request}.Context()`];
  if (ctx.features.values["call-access"]) {
    parameters.push({ name: "call", type: transport.callType });
    serviceArguments.push(transport.call);
  }
  const hasIndividualParams = options["handler-shape"] === "params";
  if (hasIndividualParams) {
    for (const field of plan.request.fields) {
      parameters.push({ name: field.name.replace(/^./, (letter) => letter.toLowerCase()), type: field.type });
      serviceArguments.push(`request.${field.name}`);
    }
  } else {
    parameters.push({ name: "request", type: plan.request.name });
    serviceArguments.push("request");
  }
  return {
    ...plan,
    path: route.path,
    params,
    parameters,
    arguments: serviceArguments,
    declaresRequest: !hasIndividualParams || params.length > 0 || !!plan.body,
  };
}

export type GoServerOperation = ReturnType<typeof serverOperationPlan>;
