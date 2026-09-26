import {
  loadPlugins,
  loadTargets,
  runPipeline,
  type SpecgenPlugin,
} from "@specgen/emitter-core";
import { resolvePath, type EmitContext } from "@typespec/compiler";
import { kotlinLanguage } from "./language.js";
import type { KotlinEmitterOptions } from "./lib.js";
import { modelsTarget } from "./models-target.js";
import type { KotlinIR } from "./transform/model.js";

export async function $onEmit(context: EmitContext<KotlinEmitterOptions>): Promise<void> {
  const { program, options } = context;
  const baseDir = program.projectRoot;
  const plugins = await loadPlugins(program, options.plugins ?? [], baseDir);
  if (!plugins) return;
  const targets = await loadTargets<KotlinIR>(program, options.targets ?? [], baseDir, "kotlin");
  if (!targets) return;
  const templateDir = options["template-dir"];
  await runPipeline<KotlinIR>({
    program,
    outputDir: context.emitterOutputDir,
    language: kotlinLanguage,
    targets: [{ target: modelsTarget, options: {} }, ...targets],
    plugins: plugins as SpecgenPlugin<KotlinIR>[],
    templateDir: templateDir ? resolvePath(baseDir, templateDir) : undefined,
    emitterOptions: { ...options },
  });
}
