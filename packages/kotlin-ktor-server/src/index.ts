import type { Target } from "@abhigyakrishna/tspgen-core";
import type { KotlinIR } from "@abhigyakrishna/tspgen-kotlin";
import { resolve } from "node:path";
import { ktorServerHelpers } from "./helpers.js";
import { ktorServerFeatures, ktorServerMovedOptions, ktorServerOptionsSchema, type KtorServerOptions } from "./options.js";
import { planServerFiles } from "./plan.js";
import { checkRuntime, serverRuntime } from "./runtime.js";

const TEMPLATES = resolve(import.meta.dirname, "../templates");

export const ktorServerTarget: Target<KotlinIR> = {
  name: "@abhigyakrishna/tspgen-kotlin-ktor-server",
  kind: "server",
  language: "kotlin",
  templates: TEMPLATES,
  helpers: { ktorServer: ktorServerHelpers },
  optionsSchema: ktorServerOptionsSchema,
  features: ktorServerFeatures,
  movedOptions: ktorServerMovedOptions,
  files: (ir, ctx) => {
    const options = ctx.options as unknown as KtorServerOptions;
    if (!checkRuntime(ctx.program, options, ctx.features)) return [];
    return planServerFiles(
      ir,
      options,
      ctx.registry,
      ctx.program,
      (template) => {
        const path = ctx.resolveTemplate?.(template);
        return path !== undefined && resolve(path) !== resolve(TEMPLATES, `${template}.eta`);
      },
      serverRuntime(options),
    );
  },
};

export default ktorServerTarget;

export { ktorServerHelpers, type HandlerField, type ResourceParam } from "./helpers.js";
export {
  ktorServerFeatures,
  ktorServerMovedOptions,
  ktorServerOptionsSchema,
  type KtorServerFeatures,
  type KtorServerOptions,
} from "./options.js";
export { builtinStyles, resolveStyle, ROUTING_STYLE_KIND, type RoutingStyle } from "./styles.js";
export { commonPrefix, routeTree, type RouteFunction, type RouteItem, type RouteNode } from "./routes.js";
export { buildUnits, type ServerUnit } from "./units.js";
export type { KtorServerMeta, ServerOpExtras } from "./plan.js";
export { withContext, type ContextParam, type ServerOperation } from "./context.js";
export { checkRuntime, serverJsonLines, serverRuntime, type ServerRuntime } from "./runtime.js";
