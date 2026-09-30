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
      return framework === "gin" ? `:p${index}` : segment;
    }
    if (/[{}:*]/.test(segment)) {
      reason = "HTTP routers require path parameters to occupy a whole segment; literal colons and wildcards are not supported";
    }
    return segment;
  });
  return { path: segments.join("/"), keys, reason };
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
  return operations.map((op) => {
    const pattern = routePattern(op.path, framework);
    let reason = pattern.reason ?? unmatchedPathParameter(op, pattern.keys);
    const key = `${op.verb} ${pattern.path}`;
    if (seen.has(key)) reason ??= `duplicate ${framework === "gin" ? "Gin" : "HTTP"} route ${key}`;
    seen.add(key);
    if (reason) {
      reportDiagnostic(ctx.program, { code: "unsupported-operation", format: { id: op.id, reason }, target: NoTarget });
    }
    return { op, path: pattern.path, keys: pattern.keys };
  });
}
