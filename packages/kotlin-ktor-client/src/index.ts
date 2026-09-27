import type { Target } from "@abhigyakrishna/tspgen-core";
import type { KotlinIR } from "@abhigyakrishna/tspgen-kotlin";
import { resolve } from "node:path";
import { ktorClientHelpers } from "./helpers.js";
import { ktorClientFeatures, ktorClientOptionsSchema, type KtorClientOptions } from "./options.js";
import { planClientFiles } from "./plan.js";
import { clientRuntime } from "./runtime.js";

export const ktorClientTarget: Target<KotlinIR> = {
  name: "@abhigyakrishna/tspgen-kotlin-ktor-client",
  kind: "client",
  language: "kotlin",
  templates: resolve(import.meta.dirname, "../templates"),
  helpers: { ktorClient: ktorClientHelpers },
  optionsSchema: ktorClientOptionsSchema,
  features: ktorClientFeatures,
  files: (ir, ctx) => {
    const options = ctx.options as unknown as KtorClientOptions;
    return planClientFiles(ir, options, ctx.program, clientRuntime(options));
  },
};

export default ktorClientTarget;

export { ktorClientHelpers } from "./helpers.js";
export { ktorClientFeatures, ktorClientOptionsSchema, type KtorClientFeatures, type KtorClientOptions } from "./options.js";
export { planClientFiles } from "./plan.js";
export { clientJsonExpr, clientRuntime, DEFAULT_CLIENT_RUNTIME, type ClientRuntime } from "./runtime.js";
