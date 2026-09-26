import type { Target } from "@tspgen/emitter-core";
import type { TsIR } from "@tspgen/emitter-typescript";
import { resolve } from "node:path";
import { nextjsHelpers } from "./helpers.js";
import { nextClientOptionsSchema, type NextClientOptions } from "./options.js";
import { planNextFiles } from "./plan.js";

export const nextClientTarget: Target<TsIR> = {
  name: "@tspgen/ts-nextjs-client",
  kind: "client",
  language: "typescript",
  templates: resolve(import.meta.dirname, "../templates"),
  helpers: { nextjs: nextjsHelpers },
  optionsSchema: nextClientOptionsSchema,
  files: (ir, ctx) => planNextFiles(ir, ctx.options as unknown as NextClientOptions, ctx),
};

export default nextClientTarget;

export { nextjsHelpers, type Field } from "./helpers.js";
export { planFlatFiles, type FlatErrorClass, type FlatMethod } from "./flat.js";
export { names } from "./names.js";
export { nextClientOptionsSchema, type NextClientOptions } from "./options.js";
export { planNextFiles, type NextOpExtras } from "./plan.js";
