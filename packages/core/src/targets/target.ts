import type { Program } from "@typespec/compiler";
import type { FeatureSet, ResolvedFeatures } from "../features.js";
import type { ApiIR } from "../ir/types.js";
import type { MovedOptions } from "../moved-options.js";
import type { ExtensionRegistry } from "../plugins/registry.js";

/** One output file: rendered from `template` (logical name) with `data`. `path` is relative, posix. */
export interface FileSpec {
  path: string;
  template: string;
  /** `features` is a reserved key here (see `FileSpec.features`): the pipeline overwrites it in the template data. */
  data: Record<string, unknown>;
  /**
   * Absolute directory `path` is relative to. Filled by the pipeline with the producing target's
   * output dir (the emitter output dir for files added by plugins) when absent.
   */
  outputDir?: string;
  /**
   * Feature values templates see in `it.features` on top of the language's. The pipeline fills it with the
   * producing target's own feature values, then spreads this on top and assigns the result to `it.features`,
   * after `data` (`runPipeline`: `{ ...file.data, features: { ...features.values, ...file.features }, ctx }`), so
   * any `features` key set in `data` is overwritten.
   */
  features?: Record<string, boolean>;
}

export interface LanguageContext {
  program: Program;
  options: Record<string, unknown>;
  /** Core, language and plugin features. */
  features: ResolvedFeatures<string>;
}

/** A language: maps ApiIR to its own IR and provides base templates/helpers. */
export interface LanguageModule<L = unknown> {
  name: string;
  /** Package name of the language emitter (diagnostics, default header text); `name` when absent. */
  emitter?: string;
  /** The language's features (spread `coreFeatures` into them); core features only when absent. */
  features?: FeatureSet<string>;
  /** The language emitter's option keys moved in 0.2.0 (core's are checked too). */
  movedOptions?: MovedOptions;
  /** Absolute path of the language's template directory (lowest-priority layer). */
  templates: string;
  helpers?: Record<string, unknown>;
  transform(ir: ApiIR, ctx: LanguageContext): L;
  format?(path: string, content: string): string | Promise<string>;
}

export interface TargetContext {
  program: Program;
  language: string;
  emitterOptions: Record<string, unknown>;
  options: Record<string, unknown>;
  registry: ExtensionRegistry;
  /** Language (with core and plugin) features merged with this target's own; the target's keys win. */
  features: ResolvedFeatures<string>;
  /** Absolute directory this target's files are written to (its `output-dir`, else the emitter output dir). */
  outputDir: string;
  /**
   * Absolute directory of the built-in models target's files. A target whose files import the models by
   * relative path must rebase those imports when it differs from `outputDir` (TypeScript targets:
   * `renderImports(file, imports, ext, modelsPrefix(ctx.outputDir, ctx.modelsOutputDir))` from
   * `@abhigyakrishna/tspgen-typescript`, which rebases imports marked `root: "models"`).
   */
  modelsOutputDir: string;
  /**
   * Absolute path of the file that renders a logical template name, after template-dir and plugin overrides;
   * `undefined` when none does. Lets a target notice that one of its templates was overridden.
   */
  resolveTemplate?(name: string): string | undefined;
}

/** A server or client library (or the language's shared models) producing files from language IR. */
export interface Target<L = unknown> {
  name: string;
  kind: "models" | "server" | "client";
  language: string;
  templates?: string;
  helpers?: Record<string, unknown>;
  /**
   * JSON schema for this target's options; defaults declared in it are applied. Must be a plain
   * `{ type: "object", properties: {...} }` schema (`loadTargets` merges `features` into its top-level
   * `properties`, replacing any `features` property already declared there): no `$ref` at the root, `allOf`, etc.
   */
  optionsSchema?: object;
  /**
   * On/off gates under this target's `features` option; their schema (`FeatureSet.schema`) is merged into
   * `optionsSchema`'s `properties.features`, replacing any `features` property `optionsSchema` already declares.
   */
  features?: FeatureSet<string>;
  /** This target's option keys moved in 0.2.0; reported as `option-moved` before its options are validated. */
  movedOptions?: MovedOptions;
  files(ir: L, ctx: TargetContext): FileSpec[];
}
