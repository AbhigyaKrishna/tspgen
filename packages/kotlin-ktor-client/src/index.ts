import type { Target } from "@tspgen/emitter-core";
import type { KotlinIR } from "@tspgen/emitter-kotlin";
import { resolve } from "node:path";
import { ktorClientHelpers } from "./helpers.js";
import { ktorClientOptionsSchema, type KtorClientOptions } from "./options.js";
import { planClientFiles } from "./plan.js";

export const ktorClientTarget: Target<KotlinIR> = {
  name: "@tspgen/kotlin-ktor-client",
  kind: "client",
  language: "kotlin",
  templates: resolve(import.meta.dirname, "../templates"),
  helpers: { ktorClient: ktorClientHelpers },
  optionsSchema: ktorClientOptionsSchema,
  files: (ir, ctx) => planClientFiles(ir, ctx.options as KtorClientOptions, ctx.program),
};

export default ktorClientTarget;

export { ktorClientHelpers } from "./helpers.js";
export { ktorClientOptionsSchema, type KtorClientOptions } from "./options.js";
export { planClientFiles } from "./plan.js";
