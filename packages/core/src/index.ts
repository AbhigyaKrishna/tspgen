export { $lib, reportDiagnostic, createDiagnostic, errorMessage } from "./lib.js";
export { pascal } from "./naming.js";
export * from "./ir/types.js";
export { buildApiIR } from "./ir/build.js";
export { collectDecorators, decoratorArg, decoratorArgs } from "./ir/decorators.js";
export { TemplateEngine, TemplateNotFoundError, type TemplateLayer } from "./templates/engine.js";
export { ExtensionRegistry } from "./plugins/registry.js";
export { definePlugin, type PluginContext, type TspGenPlugin } from "./plugins/plugin.js";
export { loadPlugins } from "./plugins/load.js";
export { loadModuleDefault } from "./loader.js";
export type { FileSpec, LanguageContext, LanguageModule, Target, TargetContext } from "./targets/target.js";
export { MANIFEST_FILE, writeOutputs, type OutputFile } from "./output/manifest.js";
export { runPipeline, type PipelineOptions, type PipelineTarget } from "./pipeline/run.js";
export { coreEmitterOptionsSchemaProperties, type CoreEmitterOptions } from "./options.js";
export { validateOptions } from "./options-validate.js";
export { loadTargets, type TargetSpec } from "./targets/load.js";
export { emitLanguage, resolveOutputDir, type LanguageEmitterOptions } from "./emitter.js";
export {
  META_DECORATOR,
  mergeMeta,
  mergeScopes,
  metaBoolean,
  metaNumber,
  metaObject,
  metaObjects,
  metaScopes,
  metaStrings,
  resolveMeta,
  type MetaData,
  type MetaScopes,
} from "./meta.js";
