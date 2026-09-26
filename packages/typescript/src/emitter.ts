import { emitLanguage } from "@tspgen/emitter-core";
import type { EmitContext } from "@typespec/compiler";
import { typescriptLanguage } from "./language.js";
import type { TypeScriptEmitterOptions } from "./lib.js";
import { tsModelsTarget } from "./models-target.js";

export async function $onEmit(context: EmitContext<TypeScriptEmitterOptions>): Promise<void> {
  await emitLanguage(context, typescriptLanguage, [tsModelsTarget]);
}
