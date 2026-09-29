import type { LanguageModule } from "@abhigyakrishna/tspgen-core";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { GO_EMITTER, goFeatures } from "./lib.js";
import { transformToGo, type GoIR } from "./transform.js";

export const goLanguage: LanguageModule<GoIR> = {
  name: "go",
  emitter: GO_EMITTER,
  features: goFeatures,
  templates: resolve(import.meta.dirname, "../templates"),
  transform: (api, ctx) => transformToGo(ctx.program, api, String(ctx.options.package ?? "models"), String(ctx.options.module ?? "")),
  format: (path, content) => {
    const normalized = content.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim() + "\n";
    return path.endsWith(".go") ? execFileSync("gofmt", { input: normalized, encoding: "utf8" }) : normalized;
  },
};
