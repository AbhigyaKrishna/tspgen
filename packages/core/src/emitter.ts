import { resolvePath, type EmitContext } from "@typespec/compiler";
import type { CoreEmitterOptions } from "./options.js";
import { loadPlugins } from "./plugins/load.js";
import type { TspGenPlugin } from "./plugins/plugin.js";
import { runPipeline } from "./pipeline/run.js";
import { loadTargets, type TargetSpec } from "./targets/load.js";
import type { LanguageModule, Target } from "./targets/target.js";

export interface LanguageEmitterOptions extends CoreEmitterOptions {
  targets?: TargetSpec[];
}

/** Standard `$onEmit` body: load plugins and targets from the project, then run the pipeline. */
export async function emitLanguage<L>(
  context: EmitContext<LanguageEmitterOptions>,
  language: LanguageModule<L>,
  builtinTargets: Target<L>[],
): Promise<void> {
  const { program, options } = context;
  const baseDir = program.projectRoot;
  const plugins = await loadPlugins(program, options.plugins ?? [], baseDir);
  if (!plugins) return;
  const targets = await loadTargets<L>(program, options.targets ?? [], baseDir, language.name);
  if (!targets) return;
  const templateDir = options["template-dir"];
  await runPipeline<L>({
    program,
    outputDir: context.emitterOutputDir,
    language,
    targets: [...builtinTargets.map((target) => ({ target, options: {} })), ...targets],
    plugins: plugins as TspGenPlugin<L>[],
    templateDir: templateDir ? resolvePath(baseDir, templateDir) : undefined,
    emitterOptions: { ...options },
  });
}
