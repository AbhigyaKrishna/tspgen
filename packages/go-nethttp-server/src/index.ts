import type { Target } from "@abhigyakrishna/tspgen-core";
import { goServerFeatures, goServerOptionsSchema, goServerFiles, type GoIR } from "@abhigyakrishna/tspgen-go";

export const goNethttpServerTarget: Target<GoIR> = {
  name: "@abhigyakrishna/tspgen-go-nethttp-server",
  kind: "server",
  language: "go",
  optionsSchema: goServerOptionsSchema,
  features: goServerFeatures,
  files: (ir, ctx) => goServerFiles(ir, ctx, "nethttp"),
};

export default goNethttpServerTarget;
