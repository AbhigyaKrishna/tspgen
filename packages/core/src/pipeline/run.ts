import { NoTarget, type Program } from "@typespec/compiler";
import { fileURLToPath } from "node:url";
import { buildApiIR } from "../ir/build.js";
import { errorMessage, reportDiagnostic } from "../lib.js";
import { writeOutputs, type OutputFile } from "../output/manifest.js";
import type { PluginContext, SpecgenPlugin } from "../plugins/plugin.js";
import { resolveMeta, type MetaScopes } from "../meta.js";
import { ExtensionRegistry } from "../plugins/registry.js";
import type { FileSpec, LanguageModule, Target } from "../targets/target.js";
import { TemplateEngine, type TemplateLayer } from "../templates/engine.js";

export interface PipelineTarget<L> {
  target: Target<L>;
  options: Record<string, unknown>;
}

export interface PipelineOptions<L> {
  program: Program;
  outputDir: string;
  language: LanguageModule<L>;
  targets: PipelineTarget<L>[];
  plugins?: SpecgenPlugin<L>[];
  templateDir?: string;
  emitterOptions?: Record<string, unknown>;
}

const FAILED = Symbol("failed");

/** build IR → language transform → plugin transforms → target files → plugin file hooks → render → write. */
export async function runPipeline<L>(opts: PipelineOptions<L>): Promise<void> {
  const { program, language } = opts;
  const emitterOptions = opts.emitterOptions ?? {};
  const registry = new ExtensionRegistry();
  const plugins = (opts.plugins ?? []).filter((p) => !p.languages || p.languages.includes(language.name));
  const ctx: PluginContext = { language: language.name, options: emitterOptions, registry };

  const guard = <T>(code: "plugin-failed" | "target-failed", name: string, stage: string, fn: () => T) => {
    try {
      return fn();
    } catch (error) {
      reportDiagnostic(program, { code, format: { name, stage, message: errorMessage(error) }, target: NoTarget });
      return FAILED;
    }
  };

  for (const plugin of plugins) {
    if (guard("plugin-failed", plugin.name, "setup", () => plugin.setup?.(ctx)) === FAILED) return;
  }

  let ir = language.transform(buildApiIR(program), { program, options: emitterOptions });
  for (const plugin of plugins) {
    if (!plugin.transformIR) continue;
    const result = guard("plugin-failed", plugin.name, "transformIR", () => plugin.transformIR!(ir, ctx));
    if (result === FAILED) return;
    if (result !== undefined) ir = result;
  }

  let files: FileSpec[] = [];
  for (const { target, options } of opts.targets) {
    const result = guard("target-failed", target.name, "files", () =>
      target.files(ir, { program, language: language.name, emitterOptions, options, registry }),
    );
    if (result === FAILED) return;
    files.push(...result);
  }
  for (const plugin of plugins) {
    if (!plugin.files) continue;
    const result = guard("plugin-failed", plugin.name, "files", () => plugin.files!(files, ir, ctx));
    if (result === FAILED) return;
    if (result !== undefined) files = result;
  }

  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) {
      reportDiagnostic(program, { code: "duplicate-file", format: { file: file.path }, target: NoTarget });
      return;
    }
    seen.add(file.path);
  }

  const engine = new TemplateEngine(templateLayers(opts, plugins), {
    meta: (item: { meta?: MetaScopes } | undefined, target?: string) => resolveMeta(item?.meta, language.name, target),
    ...language.helpers,
    ...Object.assign({}, ...opts.targets.map((t) => t.target.helpers ?? {})),
    ...Object.assign({}, ...plugins.map((p) => p.helpers ?? {})),
  });
  const outputs: OutputFile[] = [];
  let failed = false;
  for (const file of files) {
    try {
      let content = engine.render(file.template, {
        ...file.data,
        ctx: { language: language.name, options: emitterOptions },
      });
      if (language.format) content = await language.format(file.path, content);
      outputs.push({ path: file.path, content });
    } catch (error) {
      failed = true;
      reportDiagnostic(program, {
        code: "template-error",
        format: { template: file.template, file: file.path, message: errorMessage(error) },
        target: NoTarget,
      });
    }
  }
  if (failed) return;
  await writeOutputs(program, opts.outputDir, outputs);
}

function templateLayers<L>(opts: PipelineOptions<L>, plugins: SpecgenPlugin<L>[]): TemplateLayer[] {
  const layers: TemplateLayer[] = [];
  if (opts.templateDir) layers.push({ name: "template-dir", dir: opts.templateDir });
  for (const plugin of plugins) {
    if (plugin.templates) {
      const dir = typeof plugin.templates === "string" ? plugin.templates : fileURLToPath(plugin.templates);
      layers.push({ name: `plugin:${plugin.name}`, dir });
    }
  }
  for (const { target } of opts.targets) {
    if (target.templates) layers.push({ name: `target:${target.name}`, dir: target.templates });
  }
  layers.push({ name: `language:${opts.language.name}`, dir: opts.language.templates });
  return layers;
}
