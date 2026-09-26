import type { ApiIR, HttpVerb, MetaScopes, StatusCodes } from "@specgen/emitter-core";
import type { TsImport } from "../imports.js";

/** A TypeScript type at a use site, with its zod schema expression and the imports each needs. */
export interface TsTypeUse {
  text: string;
  imports: TsImport[];
  schema: string;
  schemaImports: TsImport[];
}

interface TsDeclBase {
  id: string;
  name: string;
  /** Output-relative path without extension: "models/Pet" (per-type layout) or "types" (single-file layout). */
  file: string;
  /** TypeSpec namespace of the source type ([] for anonymous types). */
  namespace: string[];
  docs?: string;
  deprecated?: string;
  meta: MetaScopes;
  /** Extra JSDoc lines from @meta. */
  jsdoc: string[];
}

export interface TsProperty {
  key: string;
  wireName: string;
  type: TsTypeUse;
  optional: boolean;
  docs?: string;
  deprecated?: string;
  /** JSON of the TypeSpec default, rendered as a JSDoc @default tag. */
  defaultDoc?: string;
  meta: MetaScopes;
  readonly: boolean;
  jsdoc: string[];
}

export interface TsInterface extends TsDeclBase {
  kind: "interface";
  properties: TsProperty[];
  extends: TsTypeUse[];
}

export interface TsAlias extends TsDeclBase {
  kind: "alias";
  type: TsTypeUse;
}

export interface TsEnumMember {
  name: string;
  value: string | number;
  docs?: string;
  meta: MetaScopes;
}

export interface TsEnum extends TsDeclBase {
  kind: "enum";
  members: TsEnumMember[];
  /** Name of an exported const tuple of the values (`@meta("typescript", #{ values })`). */
  values?: string;
}

export type TsDecl = TsInterface | TsAlias | TsEnum;

export interface TsParam {
  name: string;
  wireName: string;
  location: "path" | "query" | "header" | "cookie";
  type: TsTypeUse;
  optional: boolean;
  explode: boolean;
  docs?: string;
}

export interface TsBody {
  name: string;
  type: TsTypeUse;
  contentType: string;
  optional: boolean;
}

export interface TsHeader {
  name: string;
  wireName: string;
  type: TsTypeUse;
  optional: boolean;
}

export interface TsResultVariant {
  statusCodes: StatusCodes;
  /** Fixed status; absent for ranges/default (the variant's `status` is then `number`). */
  status?: number;
  body?: TsTypeUse;
  contentType?: string;
  headers: TsHeader[];
}

export interface TsResultDecl {
  name: string;
  file: string;
  variants: TsResultVariant[];
}

export type TsResult =
  | { kind: "single"; type: TsTypeUse; status: number; contentType?: string }
  | { kind: "union"; type: TsTypeUse; decl: TsResultDecl };

export interface TsErrorClass {
  name: string;
  file: string;
  body: TsTypeUse;
}

export interface TsError {
  statusCodes: StatusCodes;
  body?: TsTypeUse;
  contentType?: string;
  /** The error class thrown for this response (`HttpError` when there is no body). */
  errorClass: TsTypeUse;
}

export interface TsOperation {
  id: string;
  name: string;
  verb: HttpVerb;
  path: string;
  docs?: string;
  deprecated?: string;
  meta: MetaScopes;
  params: TsParam[];
  body?: TsBody;
  result: TsResult;
  errors: TsError[];
}

export interface TsGroup {
  id: string;
  name: string;
  docs?: string;
  meta: MetaScopes;
  operations: TsOperation[];
}

export interface TsService {
  id: string;
  name: string;
  docs?: string;
  groups: TsGroup[];
}

export interface TsIR {
  declarations: TsDecl[];
  errorClasses: TsErrorClass[];
  results: TsResultDecl[];
  services: TsService[];
  /** True when some service has operations (api/ files are emitted). */
  apiActive: boolean;
  zod: boolean;
  /** "" or ".js" — suffix for relative imports. */
  importExtension: string;
  /** "per-type": models/<Name>.ts; "single-file": every model in types.ts. */
  layout: "per-type" | "single-file";
  api: ApiIR;
}
