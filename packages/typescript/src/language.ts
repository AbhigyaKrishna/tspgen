import type { LanguageModule } from "@abhigyakrishna/tspgen-core";
import { resolve } from "node:path";
import { tsHelpers } from "./helpers.js";
import type { TsIR } from "./transform/model.js";
import { resolveTsOptions, transformToTs } from "./transform/index.js";

export const typescriptLanguage: LanguageModule<TsIR> = {
  name: "typescript",
  templates: resolve(import.meta.dirname, "../templates"),
  helpers: tsHelpers,
  transform: (api, ctx) => transformToTs(ctx.program, api, resolveTsOptions(ctx.options)),
  format: (_path, content) => content.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim() + "\n",
};
