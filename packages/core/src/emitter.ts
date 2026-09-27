import { resolvePath, type EmitContext } from "@typespec/compiler";
import { checkMovedOptions } from "./moved-options.js";
import { coreMovedOptions, type CoreEmitterOptions } from "./options.js";
import { loadPlugins } from "./plugins/load.js";
import type { TspGenPlugin } from "./plugins/plugin.js";
import { normalizeDir } from "./output/manifest.js";
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
  const moved = { ...coreMovedOptions, ...language.movedOptions };
  // Checked before loading targets, but not returned on immediately: a target's own moved keys (checked by
  // `loadTargets`) must still be reported in this same run, so fixing the language-level one doesn't just reveal
  // a target-level one on the next run. Plugins are not loaded, and nothing is emitted, when either fails.
  const languageMovedOk = checkMovedOptions(program, options as unknown as Record<string, unknown>, moved);
  const targets = await loadTargets<L>(program, options.targets ?? [], baseDir, language.name);
  if (!languageMovedOk || !targets) return;
  const plugins = await loadPlugins(program, options.plugins ?? [], baseDir);
  if (!plugins) return;
  const templateDir = options["template-dir"];
  const dir = (spec: string | undefined) => (spec ? resolveOutputDir(spec, baseDir, context.emitterOutputDir) : undefined);
  const modelsDir = dir(options["models-output-dir"]);
  await runPipeline<L>({
    program,
    outputDir: context.emitterOutputDir,
    language,
    targets: [
      ...builtinTargets.map((target) => ({ target, options: {}, ...(modelsDir ? { outputDir: modelsDir } : {}) })),
      ...targets.map((t) => ({ ...t, ...(t.outputDir ? { outputDir: dir(t.outputDir) } : {}) })),
    ],
    plugins: plugins as TspGenPlugin<L>[],
    templateDir: templateDir ? resolvePath(baseDir, templateDir) : undefined,
    emitterOptions: { ...options },
  });
}

/** `{project-root}` / `{emitter-output-dir}` interpolated; relative paths resolve against the project root. */
export function resolveOutputDir(spec: string, projectRoot: string, emitterOutputDir: string): string {
  const interpolated = spec.replaceAll("{project-root}", projectRoot).replaceAll("{emitter-output-dir}", emitterOutputDir);
  return normalizeDir(resolvePath(projectRoot, interpolated));
}
