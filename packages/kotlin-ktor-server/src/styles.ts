import type { ExtensionRegistry } from "@specgen/emitter-core";
import { ktorServerHelpers } from "./helpers.js";
import type { KtorServerOptions } from "./options.js";
import type { ServerUnit } from "./units.js";

/** Registry kind plugins use to add routing styles: `ctx.registry.register(ROUTING_STYLE_KIND, name, style)`. */
export const ROUTING_STYLE_KIND = "ktor-server.routing-style";

export interface RoutingStyle {
  /** Logical template name rendering one unit's routes file. */
  template: string;
  /** Imports for the routes file (type imports are added automatically). */
  imports(unit: ServerUnit, options: KtorServerOptions): string[];
  /** Fully-qualified Ktor plugins the generated module installs, e.g. Resources. */
  plugins?: string[];
}

function routeImports(unit: ServerUnit): string[] {
  const ops = unit.operations;
  return [
    "io.ktor.http.HttpStatusCode",
    "io.ktor.server.response.respond",
    "io.ktor.server.routing.Route",
    ...(ops.some((o) => o.body && !o.body.optional) ? ["io.ktor.server.request.receive"] : []),
    ...(ops.some((o) => o.body?.optional) ? ["io.ktor.server.request.receiveNullable"] : []),
    ...(ops.some((o) => o.result.kind === "sealed" && o.result.decl.variants.some((v) => v.headers.length > 0))
      ? ["io.ktor.server.response.header"]
      : []),
  ];
}

function verbs(unit: ServerUnit, pkg: string): string[] {
  return [...new Set(unit.operations.map((o) => `${pkg}.${o.verb}`))];
}

export const builtinStyles: Record<string, RoutingStyle> = {
  dsl: {
    template: "ktor-server/routes/dsl",
    imports: (unit) => [...routeImports(unit), ...verbs(unit, "io.ktor.server.routing")],
  },
  resources: {
    template: "ktor-server/routes/resources",
    plugins: ["io.ktor.server.resources.Resources"],
    imports: (unit) => [
      ...routeImports(unit),
      ...verbs(unit, "io.ktor.server.resources"),
      "io.ktor.resources.Resource",
      "kotlinx.serialization.Serializable",
      ...(unit.operations.some((op) => ktorServerHelpers.resourceParams(op).some((p) => p.serialName))
        ? ["kotlinx.serialization.SerialName"]
        : []),
    ],
  },
};

export function resolveStyle(name: string, registry: ExtensionRegistry): RoutingStyle {
  const style = registry.get<RoutingStyle>(ROUTING_STYLE_KIND, name) ?? builtinStyles[name];
  if (!style) {
    const available = [...Object.keys(builtinStyles), ...registry.names(ROUTING_STYLE_KIND)];
    throw new Error(`unknown routing style '${name}' (available: ${available.join(", ")})`);
  }
  return style;
}
