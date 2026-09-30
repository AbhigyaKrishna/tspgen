import type { Target } from "@abhigyakrishna/tspgen-core";
import { goClientFeatures, goClientOptionsSchema, type GoIR } from "@abhigyakrishna/tspgen-go";
import { resolve } from "node:path";
import { planClientFiles } from "./plan.js";

export const goNethttpClientTarget: Target<GoIR> = {
  name: "@abhigyakrishna/tspgen-go-nethttp-client",
  kind: "client",
  language: "go",
  templates: resolve(import.meta.dirname, "../templates"),
  optionsSchema: goClientOptionsSchema,
  features: goClientFeatures,
  files: planClientFiles,
};

export default goNethttpClientTarget;
