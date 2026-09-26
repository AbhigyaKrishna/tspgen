import { camel, typeName, type TsGroup, type TsOperation, type TsService } from "@tspgen/emitter-typescript";

export const names = {
  groupFile: (g: TsGroup) => `client/${camel(g.name)}`,
  groupClass: (g: TsGroup) => `${g.name}Client`,
  groupProperty: (g: TsGroup) => camel(g.name),
  params: (g: TsGroup, op: TsOperation) => `${g.name}${typeName(op.name)}Params`,
  apiClient: (s: TsService) => `${s.name}ApiClient`,
  factory: (s: TsService) => `create${s.name}Client`,
  keys: (s: TsService) => `${camel(s.name)}Keys`,
  queries: (s: TsService) => `${camel(s.name)}Queries`,
  provider: (s: TsService) => `${s.name}ClientProvider`,
  context: (s: TsService) => `${s.name}ClientContext`,
  useClient: (s: TsService) => `use${s.name}Client`,
  queryHook: (g: TsGroup, op: TsOperation) => `use${g.name}${typeName(op.name)}Query`,
  mutationHook: (g: TsGroup, op: TsOperation) => `use${g.name}${typeName(op.name)}Mutation`,
  action: (g: TsGroup, op: TsOperation) => `${camel(g.name)}${typeName(op.name)}Action`,
  actionsFile: (g: TsGroup) => `client/actions/${camel(g.name)}`,
  serverClient: (s: TsService) => `${camel(s.name)}ServerClient`,
  configureActions: (s: TsService) => `configure${s.name}Actions`,
};
