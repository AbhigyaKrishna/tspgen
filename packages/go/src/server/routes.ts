import type { TargetContext } from "@abhigyakrishna/tspgen-core";
import { NoTarget } from "@typespec/compiler";
import { reportDiagnostic } from "../lib.js";
import type { GoOperation } from "../transform/model.js";
import type { GoServerFramework } from "./transport.js";

export interface GoServerRoute {
  op: GoOperation;
  path: string;
  keys: Map<string, string>;
}

function routePattern(path: string, framework: GoServerFramework) {
  const keys = new Map<string, string>();
  let reason: string | undefined;
  const segments = path.split("/").map((segment, index) => {
    const placeholder = /^\{([^{}]+)\}$/.exec(segment);
    if (placeholder) {
      const name = placeholder[1];
      if (keys.has(name)) reason = "repeated path parameters are not supported";
      keys.set(name, `p${index}`);
      return framework === "gin" ? `:p${index}` : `{p${index}}`;
    }
    if (/[{}:*]/.test(segment)) {
      reason = "HTTP routers require path parameters to occupy a whole segment; literal colons and wildcards are not supported";
    }
    return segment;
  });
  const route = segments.join("/");
  return { path: framework === "nethttp" && route.endsWith("/") ? `${route}{$}` : route, keys, reason };
}

function literalSegment(segment: string): string {
  const bytes = Buffer.from(segment).toString("latin1");
  // Match PathUnescape's byte semantics, including invalid UTF-8 and malformed escapes.
  if (/%(?![0-9a-fA-F]{2})/.test(bytes)) return bytes;
  return bytes.replace(/%([0-9a-fA-F]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** Whole-segment, exact routes conflict when neither path/method pair is more specific. */
function netHTTPConflict(first: GoServerRoute, second: GoServerRoute): boolean {
  const methods = new Set([first.op.verb, second.op.verb]);
  if (methods.size > 1 && !(methods.has("GET") && methods.has("HEAD"))) return false;
  const firstSegments = first.path.split("/");
  const secondSegments = second.path.split("/");
  if (firstSegments.length !== secondSegments.length) return false;
  let firstSpecific = first.op.verb === "HEAD" && second.op.verb === "GET";
  let secondSpecific = second.op.verb === "HEAD" && first.op.verb === "GET";
  for (let index = 0; index < firstSegments.length; index++) {
    const firstSegment = firstSegments[index];
    const secondSegment = secondSegments[index];
    const firstWildcard = /^\{p[0-9]+\}$/.test(firstSegment);
    const secondWildcard = /^\{p[0-9]+\}$/.test(secondSegment);
    if ((firstWildcard && secondSegment === "{$}") || (secondWildcard && firstSegment === "{$}")) return false;
    if (!firstWildcard && !secondWildcard && literalSegment(firstSegment) !== literalSegment(secondSegment)) return false;
    firstSpecific ||= !firstWildcard && secondWildcard;
    secondSpecific ||= firstWildcard && !secondWildcard;
  }
  return firstSpecific === secondSpecific;
}

function unmatchedPathParameter(op: GoOperation, keys: Map<string, string>): string | undefined {
  const params = op.params.filter((param) => param.location === "path");
  if (params.some((param) => !keys.has(param.wireName))) {
    return "path parameters must have a matching route segment";
  }
  if ([...keys.keys()].some((name) => !params.some((param) => param.wireName === name))) {
    return "route placeholders must have a matching path parameter";
  }
  return undefined;
}

export function serverRoutes(operations: GoOperation[], ctx: TargetContext, framework: GoServerFramework): GoServerRoute[] {
  const seen = new Set<string>();
  const routes: GoServerRoute[] = [];
  return operations.map((op) => {
    const pattern = routePattern(op.path, framework);
    let reason = pattern.reason ?? unmatchedPathParameter(op, pattern.keys);
    const key = `${op.verb} ${pattern.path}`;
    if (seen.has(key)) reason ??= `duplicate ${framework === "gin" ? "Gin" : "HTTP"} route ${key}`;
    seen.add(key);
    const route = { op, path: pattern.path, keys: pattern.keys };
    if (!reason && framework === "nethttp") {
      const conflict = routes.find((previous) => netHTTPConflict(previous, route));
      if (conflict) reason = `HTTP route ${key} conflicts with ${conflict.op.verb} ${conflict.path}`;
    }
    if (reason) {
      reportDiagnostic(ctx.program, { code: "unsupported-operation", format: { id: op.id, reason }, target: NoTarget });
    }
    if (!reason) routes.push(route);
    return route;
  });
}
