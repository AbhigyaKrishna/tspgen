import { NoTarget, resolvePath, type Program } from "@typespec/compiler";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeFeatures, type ResolvedFeatures } from "../features.js";
import { loadSseLibraries, usesSseLibraries } from "../ir/sse.js";
import { loadVersioning, resolveServices } from "../ir/versioning.js";
import { errorMessage, reportDiagnostic } from "../lib.js";
import { normalizeDir, writeOutputs, type OutputFile } from "../output/manifest.js";
import type { PluginContext, TspGenPlugin } from "../plugins/plugin.js";
import { resolveMeta, type MetaScopes } from "../meta.js";
import { ExtensionRegistry } from "../plugins/registry.js";
import type { FileSpec, LanguageModule, Target } from "../targets/target.js";
import { TemplateEngine, TemplateNotFoundError, type TemplateLayer } from "../templates/engine.js";
import { buildFeaturedApiIR, resolveHeaderText, resolveRunFeatures } from "./run-features.js";

export interface PipelineTarget<L> {
  target: Target<L>;
  options: Record<string, unknown>;
  /** Absolute directory for this target's files; the pipeline's `outputDir` when absent. */
  outputDir?: string;
  /** This target's own features, resolved from its `features` option (see `loadTargets`). */
  features?: ResolvedFeatures<string>;
}

export interface PipelineOptions<L> {
  program: Program;
  outputDir: string;
  language: LanguageModule<L>;
  targets: PipelineTarget<L>[];
  plugins?: TspGenPlugin<L>[];
  templateDir?: string;
  emitterOptions?: Record<string, unknown>;
}

const FAILED = Symbol("failed");

/** build IR → language transform → plugin transforms → target files → plugin file hooks → render → write. */
export async function runPipeline<L>(input: PipelineOptions<L>): Promise<void> {
  // One key per physical directory: "/out" and "/out/" must share a manifest, or one run deletes the other's files.
  const opts: PipelineOptions<L> = {
    ...input,
    outputDir: normalizeDir(input.outputDir),
    targets: input.targets.map((t) => (t.outputDir ? { ...t, outputDir: normalizeDir(t.outputDir) } : t)),
  };
  const { program, language } = opts;
  const emitterOptions = opts.emitterOptions ?? {};
  const registry = new ExtensionRegistry();
  const plugins = (opts.plugins ?? []).filter((p) => !p.languages || p.languages.includes(language.name));
  const features = resolveRunFeatures(program, language, plugins, emitterOptions.features);
  if (!features) return;
  const ctx: PluginContext = { language: language.name, options: emitterOptions, registry, features };

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

  // A versioned build that cannot be resolved writes nothing: writing would clean up the previous output.
  const loaded = await loadVersioning(program);
  if (loaded.failed) return;
  const version = typeof emitterOptions.version === "string" ? emitterOptions.version : undefined;
  const resolution = resolveServices(program, loaded.versioning, version);
  if (resolution.failed) return;
  // Without the SSE libraries, event streams are untyped (the operations report sse-libraries-missing).
  const sse = usesSseLibraries(program) ? await loadSseLibraries() : undefined;
  const api = buildFeaturedApiIR(program, features, language.name, resolution.services, sse);
  let ir = language.transform(api, { program, options: emitterOptions, features });
  for (const plugin of plugins) {
    if (!plugin.transformIR) continue;
    const result = guard("plugin-failed", plugin.name, "transformIR", () => plugin.transformIR!(ir, ctx));
    if (result === FAILED) return;
    if (result !== undefined) ir = result;
  }

  const layers = templateLayers(opts, plugins);
  const resolver = new TemplateEngine(layers);
  const resolveTemplate = (name: string): string | undefined => {
    try {
      return resolver.resolve(name).path;
    } catch (error) {
      if (error instanceof TemplateNotFoundError) return undefined;
      throw error;
    }
  };
  const modelsOutputDir = opts.targets.find((t) => t.target.kind === "models")?.outputDir ?? opts.outputDir;
  let files: FileSpec[] = [];
  for (const { target, options, outputDir = opts.outputDir, features: own } of opts.targets) {
    const targetFeatures = own ? mergeFeatures(features, own) : features;
    const result = guard("target-failed", target.name, "files", () =>
      target.files(ir, {
        program,
        language: language.name,
        emitterOptions,
        options,
        registry,
        outputDir,
        modelsOutputDir,
        resolveTemplate,
        features: targetFeatures,
      }),
    );
    if (result === FAILED) return;
    files.push(
      ...result.map((file) => ({
        ...file,
        outputDir: normalizeDir(file.outputDir ?? outputDir),
        ...(own ? { features: { ...own.values, ...file.features } } : {}),
      })),
    );
  }
  for (const plugin of plugins) {
    if (!plugin.files) continue;
    const result = guard("plugin-failed", plugin.name, "files", () => plugin.files!(files, ir, ctx));
    if (result === FAILED) return;
    if (result !== undefined) files = result;
  }
  files = files.map((file) => ({ ...file, outputDir: normalizeDir(file.outputDir ?? opts.outputDir) }));

  const seen = new Set<string>();
  for (const file of files) {
    const absolute = resolvePath(file.outputDir ?? opts.outputDir, file.path);
    if (seen.has(absolute)) {
      reportDiagnostic(program, { code: "duplicate-file", format: { file: absolute }, target: NoTarget });
      return;
    }
    seen.add(absolute);
  }

  const engine = new TemplateEngine(layers, {
    meta: (item: { meta?: MetaScopes } | undefined, target?: string) => resolveMeta(item?.meta, language.name, target),
    ...language.helpers,
    ...Object.assign({}, ...opts.targets.map((t) => t.target.helpers ?? {})),
    ...Object.assign({}, ...plugins.map((p) => p.helpers ?? {})),
  });
  const headerText = resolveHeaderText(features, emitterOptions, language.emitter ?? language.name);
  const outputs = new Map<string, OutputFile[]>([[opts.outputDir, []]]);
  let failed = false;
  for (const file of files) {
    try {
      let content = engine.render(file.template, {
        ...file.data,
        features: { ...features.values, ...file.features },
        ctx: { language: language.name, options: emitterOptions, headerText },
      });
      if (language.format) content = await language.format(file.path, content);
      const dir = file.outputDir ?? opts.outputDir;
      outputs.set(dir, [...(outputs.get(dir) ?? []), { path: file.path, content }]);
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
  // Every directory gets its own manifest, with an entry per language. The emitter output dir is always
  // written and records the other directories, so a directory a target no longer writes to is cleaned up.
  const owner = language.name;
  const others = [...outputs.keys()].filter((dir) => dir !== opts.outputDir);
  for (const [dir, dirOutputs] of outputs) {
    if (dir !== opts.outputDir) await writeOutputs(program, dir, dirOutputs, { owner });
  }
  const previous = await writeOutputs(program, opts.outputDir, outputs.get(opts.outputDir) ?? [], {
    owner,
    outputDirs: others.map((dir) => relativeDir(opts.outputDir, dir)).sort(),
  });
  for (const rel of previous.outputDirs ?? []) {
    const dir = normalizeDir(resolvePath(opts.outputDir, rel));
    if (!outputs.has(dir)) await writeOutputs(program, dir, [], { owner });
  }
}

/** `to` relative to `from`, posix separators (manifests are portable across machines). */
function relativeDir(from: string, to: string): string {
  return relative(from, to).split(sep).join("/") || ".";
}

function templateLayers<L>(opts: PipelineOptions<L>, plugins: TspGenPlugin<L>[]): TemplateLayer[] {
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
