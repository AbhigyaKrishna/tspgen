import type { ApiIR, AuthIR, HttpVerb, MetaScopes, ServerIR, StatusCodes } from "@tspgen/emitter-core";

/** A Kotlin type as written at a use site, with the imports it needs. */
export interface KtTypeUse {
  text: string;
  imports: string[];
  nullable: boolean;
}

interface KtDeclBase {
  /** Source IR type id. */
  id: string;
  name: string;
  package: string;
  fqn: string;
  docs?: string;
  /** Annotation source lines (e.g. `@Deprecated("x")`, user @Kotlin.annotate values). */
  annotations: string[];
  meta: MetaScopes;
  /** Extra imports from @meta. */
  imports: string[];
}

export interface KtProperty {
  name: string;
  wireName: string;
  /** Set when the Kotlin name differs from the wire name. */
  serialName?: string;
  type: KtTypeUse;
  /** Kotlin default-value expression. */
  default?: string;
  override: boolean;
  docs?: string;
  annotations: string[];
  meta: MetaScopes;
}

export interface KtDataClass extends KtDeclBase {
  kind: "data-class";
  properties: KtProperty[];
  /** Polymorphic serial name (discriminator value). */
  serialName?: string;
  /** Fully-qualified names of implemented sealed interfaces. */
  implements: string[];
  /** Kotlin statements for the `init` block (validation checks, @meta checks lines). */
  checks: string[];
}

export interface KtSealedInterface extends KtDeclBase {
  kind: "sealed-interface";
  discriminator: string;
  properties: KtProperty[];
  implements: string[];
}

export interface KtEnumMember {
  name: string;
  serialName: string;
  docs?: string;
  annotations: string[];
  meta: MetaScopes;
}

export interface KtEnum extends KtDeclBase {
  kind: "enum";
  members: KtEnumMember[];
}

export interface KtTypeAlias extends KtDeclBase {
  kind: "typealias";
  target: KtTypeUse;
}

export type KtDecl = KtDataClass | KtSealedInterface | KtEnum | KtTypeAlias;

export interface KtParam {
  name: string;
  wireName: string;
  location: "path" | "query" | "header" | "cookie";
  type: KtTypeUse;
  optional: boolean;
  explode: boolean;
  docs?: string;
}

export interface KtBody {
  name: string;
  type: KtTypeUse;
  contentType: string;
  optional: boolean;
}

export interface KtResponse {
  statusCodes: StatusCodes;
  isError: boolean;
  description?: string;
  headers: KtParam[];
  body?: KtTypeUse;
  contentType?: string;
}

export interface KtOperation {
  id: string;
  name: string;
  verb: HttpVerb;
  path: string;
  docs?: string;
  annotations: string[];
  meta: MetaScopes;
  params: KtParam[];
  body?: KtBody;
  responses: KtResponse[];
  /** How the operation's success responses surface in Kotlin. */
  result: KtResult;
  /** Error responses and the exception type carrying each. */
  errors: KtError[];
}

export interface KtGroup {
  id: string;
  name: string;
  namespace: string[];
  /** Kotlin package mapped from the group's namespace (`packages` option); absent when unmapped. */
  package?: string;
  docs?: string;
  annotations: string[];
  meta: MetaScopes;
  operations: KtOperation[];
}

export interface KtService {
  id: string;
  name: string;
  package: string;
  docs?: string;
  servers: ServerIR[];
  auth: AuthIR[];
  groups: KtGroup[];
}

export interface KotlinIR {
  basePackage: string;
  modelsPackage: string;
  apiPackage: string;
  declarations: KtDecl[];
  apiDeclarations: KtApiDecl[];
  services: KtService[];
  api: ApiIR;
}

export type KtResult =
  | { kind: "single"; type: KtTypeUse; status: number; contentType?: string }
  | { kind: "sealed"; type: KtTypeUse; decl: KtResultDecl };

export interface KtResultVariant {
  name: string;
  statusCodes: StatusCodes;
  /** Fixed status code; absent for ranges/default (the variant then carries `status`). */
  status?: number;
  body?: KtTypeUse;
  contentType?: string;
  headers: KtParam[];
}

export interface KtError {
  statusCodes: StatusCodes;
  body?: KtTypeUse;
  contentType?: string;
  exception: KtTypeUse;
}

interface KtApiDeclBase {
  id: string;
  name: string;
  package: string;
  fqn: string;
  docs?: string;
  annotations: string[];
}

export interface KtResultDecl extends KtApiDeclBase {
  kind: "result";
  variants: KtResultVariant[];
}

export interface KtExceptionDecl extends KtApiDeclBase {
  kind: "exception";
  body: KtTypeUse;
  /** Default status when every use of this error type has the same fixed code. */
  defaultStatus?: number;
}

export interface KtApiExceptionDecl extends KtApiDeclBase {
  kind: "api-exception";
}

export type KtApiDecl = KtResultDecl | KtExceptionDecl | KtApiExceptionDecl;
