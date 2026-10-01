import { emitLanguage } from "@abhigyakrishna/tspgen-core";
import type { EmitContext } from "@typespec/compiler";
import type { GoEmitterOptions } from "./lib.js";
import { goLanguage } from "./language.js";
import { goModelsTarget } from "./models-target.js";

export async function $onEmit(context: EmitContext<GoEmitterOptions>): Promise<void> {
  await emitLanguage(context, goLanguage, [goModelsTarget]);
}
