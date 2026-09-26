import { emitLanguage } from "@specgen/emitter-core";
import type { EmitContext } from "@typespec/compiler";
import { kotlinLanguage } from "./language.js";
import type { KotlinEmitterOptions } from "./lib.js";
import { modelsTarget } from "./models-target.js";

export async function $onEmit(context: EmitContext<KotlinEmitterOptions>): Promise<void> {
  await emitLanguage(context, kotlinLanguage, [modelsTarget]);
}
