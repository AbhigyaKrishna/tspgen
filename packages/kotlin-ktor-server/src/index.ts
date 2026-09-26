import type { Target } from "@specgen/emitter-core";
import type { KotlinIR } from "@specgen/emitter-kotlin";
import { resolve } from "node:path";
import { ktorServerHelpers } from "./helpers.js";
import { ktorServerOptionsSchema, type KtorServerOptions } from "./options.js";
import { planServerFiles } from "./plan.js";

export const ktorServerTarget: Target<KotlinIR> = {
  name: "@specgen/kotlin-ktor-server",
  kind: "server",
  language: "kotlin",
  templates: resolve(import.meta.dirname, "../templates"),
  helpers: { ktorServer: ktorServerHelpers },
  optionsSchema: ktorServerOptionsSchema,
  files: (ir, ctx) => planServerFiles(ir, ctx.options as unknown as KtorServerOptions, ctx.registry),
};

export default ktorServerTarget;

export { ktorServerHelpers, type HandlerField, type ResourceParam } from "./helpers.js";
export { ktorServerOptionsSchema, type KtorServerOptions } from "./options.js";
export { builtinStyles, resolveStyle, ROUTING_STYLE_KIND, type RoutingStyle } from "./styles.js";
export { buildUnits, type ServerUnit } from "./units.js";
