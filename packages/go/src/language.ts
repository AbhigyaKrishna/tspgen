import type { LanguageModule } from "@abhigyakrishna/tspgen-core";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { GO_EMITTER, goFeatures } from "./lib.js";
import { transformToGo, type GoIR } from "./transform.js";
import { resolveGoOptions } from "./options.js";

export const goLanguage: LanguageModule<GoIR> = {
  name: "go",
  emitter: GO_EMITTER,
  features: goFeatures,
  templates: resolve(import.meta.dirname, "../templates"),
  transform: (api, ctx) => transformToGo(
    ctx.program,
    api,
    String(ctx.options.package ?? "models"),
    String(ctx.options.module ?? ""),
    resolveGoOptions(ctx.options, ctx.features),
  ),
  format: (path, content) => {
    const normalized = content.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim() + "\n";
    return path.endsWith(".go") ? gofmt(path, normalized) : normalized;
  },
};

function gofmt(path: string, source: string): string {
  try {
    return execFileSync("gofmt", { input: source, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    if (failure.code === "ENOENT") throw new Error("gofmt was not found on PATH; the Go emitter requires a Go toolchain.", { cause: error });
    throw new Error(`gofmt rejected generated ${path}:\n${failure.stderr ?? failure.message}`, { cause: error });
  }
}
