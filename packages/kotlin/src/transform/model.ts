import type {
  ApiIR,
  ApiVersionConstant,
  AuthIR,
  AuthRequirementIR,
  HttpVerb,
  MetaScopes,
  ServerIR,
  StatusCodes,
} from "@abhigyakrishna/tspgen-core";

/** A Kotlin type as written at a use site, with the imports it needs. */
export interface KtTypeUse {
  text: string;
  imports: string[];
  nullable: boolean;
  /** Element of a `List` (set by `listOf`); parameter codecs convert list items with it. */
  element?: KtTypeUse;
  /** Value of a `Map<String, …>` (set by `mapOf`); keys are always `String`. */
  value?: KtTypeUse;
  /** A generic type's base (`Page`) and type arguments (set by `genericOf`). */
  generic?: { base: KtTypeUse; args: KtTypeUse[] };
  /**
   * Serializer (simple name) giving this scalar its JSON form, e.g. `LongAsStringSerializer` for `@encode(string)`:
   * a model property of this type is annotated `@Serializable(with = <serializer>::class)`.
   */
  serializer?: string;
  /** Imports `serializer` / `serialText` need. */
  serialImports?: string[];
  /** The type as written in a model when an element needs a serializer: `List<@Serializable(with = …) Long>`. */
  serialText?: string;
  /** A user scalar declared as a typealias or value class: its base type. Parameter codecs convert through it. */
  underlying?: KtTypeUse;
  /** `"value-class"`: values are wrapped (`PetId(raw)`; `id.value` for the raw value). */
  wrapper?: "value-class";
  /** Classes whose generated serializers this type needs though it does not name them (typealiases of java.time). */
  needs?: string[];
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
  /** Type as written in the class when it differs from `type.text` (serializer annotations on elements). */
  serialType?: string;
  /** Imports the property's serializer annotations need. */
  serialImports?: string[];
  /**
   * A required property with a default: written as `@EncodeDefault(EncodeDefault.Mode.ALWAYS)` so the key stays on the
   * wire when the Json omits defaults (`encodeDefaults = false`) — other languages' models require it.
   */
  encodeDefault?: boolean;
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
  /** Type parameters of a generic class (`Page<T>` → ["T"]). */
  typeParameters?: string[];
  /** Not `@Serializable`: a multipart request body model, whose file parts are `HttpFile`s. */
  plain?: boolean;
}

export interface KtSealedInterface extends KtDeclBase {
  kind: "sealed-interface";
  discriminator: string;
  properties: KtProperty[];
  implements: string[];
  /** Variant data classes declared inside the interface (`union-variants: nested`); FQN `<fqn>.<name>`. */
  variants: KtDataClass[];
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
  /** `features.enum-unknown`: name of the fallback member unknown wire values decode to (declared last). */
  unknown?: string;
  /** Name of the nested `Serializer` object, set together with `unknown`: `Serializer` unless a member has that name. */
  serializerName?: string;
}

export interface KtTypeAlias extends KtDeclBase {
  kind: "typealias";
  target: KtTypeUse;
}

/** How user scalars are declared; see the `scalar-style` option. */
export type ScalarStyle = "inline" | "typealias" | "value-class";

/** A user scalar with `scalar-style: value-class`: `@JvmInline value class <name>(val value: <value>)`. */
export interface KtValueClass extends KtDeclBase {
  kind: "value-class";
  value: KtTypeUse;
  /** `init { }` check lines (throwing `ModelCheckException`) from the scalar's own constraints (features.validation). */
  checks: string[];
}

/** One event of an `@events` union: a class nested in the events interface. */
export interface KtEvent {
  /** Nested class name. */
  name: string;
  /** SSE `event:` value. */
  event: string;
  /** Payload type (`val data`); absent for a literal payload, whose class is a `data object`. */
  data?: KtTypeUse;
  /** Wire `data:` of a literal payload (JSON-encoded for a JSON payload). */
  literal?: string;
  /** The payload is JSON (else text: a string payload as-is, other scalars by `toString()` / parsing). */
  json: boolean;
  /** `@terminalEvent`: the stream ends after it. */
  terminal: boolean;
  docs?: string;
}

/** An `@events` union: a sealed interface with one nested class per event; not `@Serializable`. */
export interface KtEvents extends KtDeclBase {
  kind: "events";
  events: KtEvent[];
}

export type KtDecl = KtDataClass | KtSealedInterface | KtEnum | KtTypeAlias | KtEvents | KtValueClass;

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
  kind: "single" | "multipart" | "file";
  /** Parts of a multipart body, in declaration order. */
  parts?: KtPart[];
  /** A file body: `type` is `HttpFile`. */
  file?: KtFileBody;
}

/** One part of a multipart body, read from / written to a property of the request class. */
export interface KtPart {
  /** Property of the request class. */
  name: string;
  wireName: string;
  kind: "file" | "text" | "json";
  /** Repeated part: the property is a `List` of `type`. */
  multi: boolean;
  optional: boolean;
  /** Type of one value (`HttpFile` for file parts); never nullable. */
  type: KtTypeUse;
  /** Declared content types; [] when any. */
  contentTypes: string[];
}

export interface KtFileBody {
  isText: boolean;
  /** Declared content types; [] when any. */
  contentTypes: string[];
}

export interface KtResponse {
  statusCodes: StatusCodes;
  isError: boolean;
  description?: string;
  headers: KtParam[];
  /** The body type; for a stream, its element type (the events interface or `SseMessage`). */
  body?: KtTypeUse;
  contentType?: string;
  stream?: KtStream;
}

/** A server-sent event stream: a `Flow` of events. */
export interface KtStream {
  /** Element type: the events interface of a typed stream, else `SseMessage`. */
  type: KtTypeUse;
  /** The events declaration of a typed stream. */
  events?: KtEvents;
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
  /** Resolved `@useAuth` requirement (see `AuthRequirementIR`); absent without one. */
  auth?: AuthRequirementIR;
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
  /** `const val` version constants of the versioned services (`ApiVersionConstants.kt` in the models package). */
  apiVersions: ApiVersionConstant[];
  /** FQN of the generated `HttpFile` class, when any type uses `Http.File`. */
  httpFile?: string;
  /** FQN of the generated `SseMessage` class, when an operation streams untyped server-sent events. */
  sseMessage?: string;
  /** Classes with a generated serializer in ModelSerializers.kt that the API uses (models, parameters, bodies). */
  serializers: string[];
  /**
   * FQN of the generated `modelSerializersModule` (the `serializers` as contextual serializers), when `serializers` is
   * not empty: bodies that are such values themselves (`List<Instant>`) need it in the Json configuration.
   */
  serializersModule?: string;
  /**
   * FQN of the generated `ModelCheckException`, when a model has a check throwing it (constraint decorators,
   * `notBlank`, or an @meta check naming it): targets reference it only then.
   */
  modelCheckException?: string;
  /** `@encode(string)` on uint64 is used: ModelSerializers.kt declares `ULongAsStringSerializer`. */
  ulongAsString?: boolean;
  /**
   * `scalar-style: value-class` scalars used with a use's own `@encode(string)`: ModelSerializers.kt declares
   * `<name>AsStringSerializer` for each, wrapping `LongAsStringSerializer`/`ULongAsStringSerializer`.
   */
  valueClassAsString?: { name: string; fqn: string; wraps: "Long" | "ULong" }[];
}

export type KtResult =
  /** `stream`: a server-sent event stream; `type` is then `Flow<element>`. */
  | { kind: "single"; type: KtTypeUse; status: number; contentType?: string; stream?: KtStream }
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
