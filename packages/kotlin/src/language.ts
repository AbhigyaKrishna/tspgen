import type { LanguageModule } from "@abhigyakrishna/tspgen-core";
import { resolve } from "node:path";
import { kotlinHelpers } from "./helpers.js";
import { KOTLIN_EMITTER, kotlinFeatures, kotlinMovedOptions } from "./lib.js";
import type { KotlinIR } from "./transform/model.js";
import { resolveKotlinOptions, transformToKotlin } from "./transform/index.js";

export const kotlinLanguage: LanguageModule<KotlinIR> = {
  name: "kotlin",
  emitter: KOTLIN_EMITTER,
  templates: resolve(import.meta.dirname, "../templates"),
  helpers: kotlinHelpers,
  features: kotlinFeatures,
  movedOptions: kotlinMovedOptions,
  transform: (api, ctx) => transformToKotlin(ctx.program, api, resolveKotlinOptions(ctx.options, ctx.features)),
  format: (_path, content) =>
    content.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim() + "\n",
};
