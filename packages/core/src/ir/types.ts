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
  /** `Http.File` or a model extending it: each language maps it to its built-in file type. */
  | { kind: "file" }
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
  /**
   * Decorators of the enclosing namespaces, outermost first; present only when one of them has non-TypeSpec
   * decorators. Used for `@meta` feature overrides (`features`), which namespaces pass on to their types.
   */
  namespaceDecorators?: DecoratorData[];
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
  /** Declares `HttpPart` properties: a multipart body shape, never serialized as JSON. */
  multipart?: boolean;
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
  /**
   * An `@events` union (`@typespec/events`): the events of a typed server-sent event stream, one per variant, in
   * declaration order. `variants` then hold the event payload types.
   */
  events?: EventIR[];
}

/** One event of an `@events` union. */
export interface EventIR {
  /** SSE `event:` field value: the variant name, "message" for an unnamed variant. */
  name: string;
  /** Payload type: the `@data` property's type of an event envelope, else the variant's type. */
  payload: TypeRef;
  /**
   * Payload content type: its `@contentType`; otherwise "text/plain" for string (and string literal) payloads,
   * "application/json" for the others.
   */
  contentType: string;
  /** `@terminalEvent`: the server ends the stream after this event. */
  terminal: boolean;
  docs?: string;
}

/** A streamed response body. */
export interface StreamIR {
  protocol: "sse";
  /** Events of a typed stream (the response body type is the `@events` union); absent for an untyped stream. */
  events?: EventIR[];
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
  /** The version generated, for a `@versioned` service (the `version` option, or its latest version). */
  version?: { name: string; value: string };
  groups: OperationGroupIR[];
}

export interface ServerIR {
  url: string;
  description?: string;
  parameters: string[];
}

/** An auth scheme; `ServiceIR.auth` lists every scheme the service or any of its operations uses. */
export interface AuthIR {
  /** Scheme id (the scheme model's name); a different scheme reusing an id gets `_` appended, as in OpenAPI output. */
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
  /**
   * Decorators of the namespaces enclosing the group, outermost first (the group's own excluded), excluding the
   * global namespace.
   */
  namespaceDecorators: DecoratorData[];
  /**
   * Where `id`/`decorators`/`docs` come from: `"interface"` normally, or `"namespace"` for operations declared
   * directly in a namespace (no interface) — that namespace's own `@meta` checks (`checkMetaFeatures`) already
   * ran as `"namespace"` while walking every namespace in the program, so it must not be checked again as
   * `"interface"` (an override level like `"model"` allows one kind and not the other).
   */
  container: "interface" | "namespace";
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
  /** Resolved `@useAuth` (operation, then interface, then enclosing namespaces); absent when none applies. */
  auth?: AuthRequirementIR;
}

/**
 * An operation's auth requirement: any one of `options` suffices, and each option lists scheme ids
 * (`AuthIR.id`) that are all required. `NoAuth` is an empty option: `@useAuth(NoAuth)` is `[[]]`,
 * `@useAuth(A | NoAuth)` is `[["A"], []]`, `@useAuth(A & B)` is `[["A", "B"]]`.
 */
export interface AuthRequirementIR {
  options: string[][];
}

export interface ParamIR extends DocInfo {
  name: string;
  wireName: string;
  location: "path" | "query" | "header" | "cookie";
  type: TypeRef;
  optional: boolean;
  explode: boolean;
  constraints?: ConstraintsIR;
}

export interface BodyIR {
  /** Name of the explicit `@body` parameter, when there is one. */
  name?: string;
  /** Doc comment of the explicit `@body` parameter. */
  docs?: string;
  type: TypeRef;
  contentTypes: string[];
  optional: boolean;
  kind: "single" | "multipart" | "file";
  /** Constraint decorators of the explicit `@body` parameter. */
  constraints?: ConstraintsIR;
  /** Parts of a `multipart` body (model form), in declaration order. */
  parts?: PartIR[];
  /** A `file` body (`Http.File`). */
  file?: FileBodyIR;
}

/** One part of a model-form `@multipartBody`. */
export interface PartIR {
  /** Wire part name. */
  name: string;
  /** Property of the multipart body model defining the part. */
  property: string;
  optional: boolean;
  /** `HttpPart<T>[]`: the part may repeat. */
  multi: boolean;
  kind: "file" | "text" | "json";
  /** Value type of one part: `{ kind: "file" }` for files, else the part's `T`. */
  type: TypeRef;
  /** Allowed part content types; for file parts the declared file content types ([] when any). */
  contentTypes: string[];
  docs?: string;
}

export interface FileBodyIR {
  /** The file contents are declared as `string` rather than `bytes`. */
  isText: boolean;
  /** Declared file content types ([] when any). */
  contentTypes: string[];
}

export type StatusCodes = number | { start: number; end: number } | "default";

export interface ResponseIR {
  statusCodes: StatusCodes;
  description?: string;
  isError: boolean;
  headers: HeaderIR[];
  /**
   * `stream`: a server-sent event stream (`text/event-stream`), set only on the single success response of an
   * operation. Its `type` is the `@events` union of a typed stream, the declared body type (string) otherwise.
   */
  body?: { type: TypeRef; contentTypes: string[]; stream?: StreamIR };
}

export interface HeaderIR {
  name: string;
  wireName: string;
  type: TypeRef;
  optional: boolean;
}
