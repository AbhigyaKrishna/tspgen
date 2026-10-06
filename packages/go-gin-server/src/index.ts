import type { Target } from "@abhigyakrishna/tspgen-core";
import { goServerFeatures, goServerOptionsSchema, goServerFiles, type GoIR } from "@abhigyakrishna/tspgen-go";
import { resolve } from "node:path";

export const goGinServerTarget: Target<GoIR> = {
  name: "@abhigyakrishna/tspgen-go-gin-server",
  kind: "server",
  language: "go",
  templates: resolve(import.meta.dirname, "../templates"),
  optionsSchema: goServerOptionsSchema,
  features: goServerFeatures,
  files: (ir, ctx) => goServerFiles(ir, ctx, "gin"),
};

export default goGinServerTarget;
