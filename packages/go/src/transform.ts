export { fileName, goName, localModuleVersion, validModule, validPackage } from "./naming.js";
export type { GoIR, GoDecl, GoField, GoOperation, GoType } from "./transform/model.js";
export { goType, goTypeName, typeUse } from "./transform/type-map.js";
export { transformToGo } from "./transform/declarations.js";
export { goOperations } from "./transform/operations.js";
