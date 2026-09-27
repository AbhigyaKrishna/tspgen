/** Decorator data keyed by fully-qualified decorator name; one args array per application. */
export type DecoratorData = Record<string, unknown[][]>;

export type TypeRef =
  /** `args`: type arguments of a generic model (one with `typeParameters`). */
  | { kind: "named"; id: string; args?: TypeRef[] }
  /** A type parameter of the enclosing generic model. */
  | { kind: "typeParam"; name: string }
  | { kind: "array"; of: TypeRef }
  | { kind: "map"; of: TypeRef }
  | { kind: "scalar"; name: string; custom?: CustomScalarIR }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "nullable"; of: TypeRef }
  | { kind: "unknown" };

/** A user-declared scalar; `name` on the TypeRef is its TypeSpec std root. */
export interface CustomScalarIR {
  id: string;
  name: string;
  decorators: DecoratorData;
}

/** TypeSpec constraint decorators on a property (or its scalar type). */
export interface ConstraintsIR {
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minValue?: number;
  maxValue?: number;
  pattern?: string;
}

export interface DocInfo {
  docs?: string;
  deprecated?: string;
}

interface NamedTypeBase extends DocInfo {
  id: string;
  name: string;
  namespace: string[];
  decorators: DecoratorData;
}

export interface ModelIR extends NamedTypeBase {
  kind: "model";
  properties: PropertyIR[];
  baseId?: string;
  additionalProperties?: TypeRef;
  /** mapping: discriminator value → model id */
  discriminator?: { property: string; mapping: Record<string, string> };
  /**
   * Template-instance arguments (`Page<Pet>` → [Pet]) of a mapped instance collected per use
   * (`generics: false`, or a template that cannot be generic); absent otherwise.
   */
  templateArgs?: TypeRef[];
  /** Type parameter names of a generic model (`Page<T>` → ["T"]); its uses are `named` refs with `args`. */
  typeParameters?: string[];
}

export interface PropertyIR extends DocInfo {
  name: string;
  wireName: string;
  type: TypeRef;
  optional: boolean;
  default?: unknown;
  /** Present only when at least one constraint applies. */
  constraints?: ConstraintsIR;
  decorators: DecoratorData;
}

export interface EnumIR extends NamedTypeBase {
  kind: "enum";
  members: EnumMemberIR[];
}

export interface EnumMemberIR extends DocInfo {
  name: string;
  value: string | number;
  decorators: DecoratorData;
}

export interface UnionIR extends NamedTypeBase {
  kind: "union";
  variants: UnionVariantIR[];
  discriminator?: { property: string; envelope: "object" | "none"; envelopeProperty: string };
}

export interface UnionVariantIR extends DocInfo {
  name?: string;
  type: TypeRef;
}

export type TypeIR = ModelIR | EnumIR | UnionIR;

export interface ApiIR {
  services: ServiceIR[];
  types: TypeIR[];
}

export interface ServiceIR extends DocInfo {
  id: string;
  name: string;
  title?: string;
  namespace: string[];
  servers: ServerIR[];
  auth: AuthIR[];
  groups: OperationGroupIR[];
}

export interface ServerIR {
  url: string;
  description?: string;
  parameters: string[];
}

export interface AuthIR {
  id: string;
  type: "http" | "apiKey" | "oauth2" | "openIdConnect" | "noAuth";
  scheme?: string;
  in?: "header" | "query" | "cookie";
  name?: string;
}

export interface OperationGroupIR extends DocInfo {
  id: string;
  name: string;
  namespace: string[];
  decorators: DecoratorData;
  /** Decorators of the namespaces enclosing the group, service namespace first (the group's own excluded). */
  namespaceDecorators: DecoratorData[];
  operations: OperationIR[];
}

export type HttpVerb = "get" | "put" | "post" | "patch" | "delete" | "head";

export interface OperationIR extends DocInfo {
  id: string;
  name: string;
  verb: HttpVerb;
  path: string;
  params: ParamIR[];
  body?: BodyIR;
  responses: ResponseIR[];
  decorators: DecoratorData;
}

export interface ParamIR extends DocInfo {
  name: string;
  wireName: string;
  location: "path" | "query" | "header" | "cookie";
  type: TypeRef;
  optional: boolean;
  explode: boolean;
}

export interface BodyIR {
  /** Name of the explicit `@body` parameter, when there is one. */
  name?: string;
  type: TypeRef;
  contentTypes: string[];
  optional: boolean;
  kind: "single" | "multipart" | "file";
}

export type StatusCodes = number | { start: number; end: number } | "default";

export interface ResponseIR {
  statusCodes: StatusCodes;
  description?: string;
  isError: boolean;
  headers: HeaderIR[];
  body?: { type: TypeRef; contentTypes: string[] };
}

export interface HeaderIR {
  name: string;
  wireName: string;
  type: TypeRef;
  optional: boolean;
}
