export { $lib, reportDiagnostic, type TypeScriptEmitterOptions } from "./lib.js";
export { $onEmit } from "./emitter.js";
export { camel, memberName, propertyKey, RESERVED_WORDS, typeName } from "./naming.js";
export { modelsPrefix, rebase, relativeSpecifier, renderImports, type TsImport } from "./imports.js";
export * from "./transform/index.js";
export {
  arrayOf,
  declUse,
  externalUse,
  FILE,
  genericOf,
  literalUse,
  nullable,
  objectUse,
  recordOf,
  scalarUse,
  simple,
  unionOf,
  UNKNOWN,
  VOID,
} from "./transform/type-map.js";
export { HTTP_ERROR } from "./transform/operations.js";
export { typescriptLanguage } from "./language.js";
export { tsModelsTarget } from "./models-target.js";
export { tsHelpers } from "./helpers.js";
