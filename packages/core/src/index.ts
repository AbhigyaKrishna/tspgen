export { $lib, reportDiagnostic, createDiagnostic, errorMessage } from "./lib.js";
export { apiVersionConstants, pascal, type ApiVersionConstant } from "./naming.js";
export * from "./ir/types.js";
export { buildApiIR, type BuildOptions } from "./ir/build.js";
export {
  loadVersioning,
  resolveServices,
  type LoadedVersioning,
  type ResolvedService,
  type ServiceResolution,
  type VersioningApi,
} from "./ir/versioning.js";
export { loadSseLibraries, usesSseLibraries, type EventDefinition, type SseLibraries } from "./ir/sse.js";
export { collectDecorators, decoratorArg, decoratorArgs, enclosingNamespaceDecorators } from "./ir/decorators.js";
export { defaultHeaderText, lineComments } from "./comments.js";
export { TemplateEngine, TemplateNotFoundError, type TemplateLayer } from "./templates/engine.js";
export { ExtensionRegistry } from "./plugins/registry.js";
export { definePlugin, type PluginContext, type TspGenPlugin } from "./plugins/plugin.js";
export { loadPlugins } from "./plugins/load.js";
export { loadModuleDefault } from "./loader.js";
export type { FileSpec, LanguageContext, LanguageModule, Target, TargetContext } from "./targets/target.js";
export { MANIFEST_FILE, normalizeDir, writeOutputs, type OutputFile } from "./output/manifest.js";
export { runPipeline, type PipelineOptions, type PipelineTarget } from "./pipeline/run.js";
export { coreEmitterOptionsSchemaProperties, coreMovedOptions, type CoreEmitterOptions } from "./options.js";
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
export {
  coreFeatures,
  defineFeatures,
  mergeFeatures,
  overrideAllowed,
  reportUnsupportedFeature,
  type FeatureDef,
  type FeatureNodeKind,
  type FeatureOverride,
  type FeatureSet,
  type ResolvedFeatures,
} from "./features.js";
export { declarationScopes } from "./ir/feature-meta.js";
export { checkMovedOptions, movedOptionSchemas, type MovedOptions } from "./moved-options.js";
export { authDocs, authHeader, authHeaderConflicts, authKind, authSchemeTarget, type AuthKind } from "./auth.js";
