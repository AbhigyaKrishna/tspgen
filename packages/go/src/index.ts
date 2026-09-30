export { $lib, GO_EMITTER, goFeatures, reportDiagnostic, type GoEmitterOptions } from "./lib.js";
export { $onEmit } from "./emitter.js";
export { goLanguage } from "./language.js";
export { goModelsTarget } from "./models-target.js";
export { constraintsLiteral, nullShape } from "./models-target.js";
export {
  fileName, goName, goOperations, goType, goTypeName, typeUse, localModuleVersion,
  transformToGo, validModule, validPackage,
  type GoIR, type GoDecl, type GoOperation, type GoType,
} from "./transform.js";
export * from "./options.js";
export * from "./http.js";
export { goServerFiles } from "./server.js";
export { goSourceFile, type GoSourceSection } from "./source.js";
export { httpOperationPlan, type GoHTTPOperation } from "./http/operations.js";
export { httpModuleFile } from "./http/files.js";
