# Changelog

All packages (`@abhigyakrishna/tspgen-core`, `-kotlin`, `-kotlin-ktor-server`, `-kotlin-ktor-client`,
`-typescript`, `-ts-nextjs-client`) are released together with the same version.

## Unreleased

### Changed

- **Breaking** — Core: per-instance names of nested template instances (`features.generics: false`, or templates that
  cannot be generic) now include every argument level: `Page<Box<Cat>>` → `PageBoxCat` (was `PageBox`),
  `Page<Pet[]>` → `PageArrayPet`, `Box<Record<string>>` → `BoxRecordString`. This fixes collisions such as
  `Page<Pet[]>` and `Page<Tag[]>` both being named `PageArray`; generated class names and files change accordingly.
- **Breaking** — Core: templates spreading a `Record<T>` of a type parameter (`model Bag<T> { ...Record<T> }`) are
  generated per instance (`Bag<string>` → `BagString`) instead of as one generic model, so each instance keeps its
  additional properties.

## 0.2.1 — 2026-09-28

### Added

- Ktor server: `ServerError` (`status`, safe `detail`, `kind`, `cause`), `ServerErrorKind` and
  `ServerErrorResponder` in `ServerSupport.kt`; `<svc>Errors(responder)` sends every error without a declared body
  (unmapped `ApiException`, 400, 413, 415) through the responder, so an API can answer them in its own error model.
  The default follows `error-body` (problem+json, or status only with `none`).
- Ktor server: `ApplicationCall.serverErrorOf(cause)` classifies the same errors for a hand-written StatusPages;
  `respondProblem()` is public and emitted whatever `error-body` says.
- Ktor server: `features.errors` (default `true`); `false` skips `<Service>Errors.kt` and the module's StatusPages
  install, so no StatusPages dependency is needed.
- Ktor server: `features.explicit-nulls` (default `true`); `false` sets `explicitNulls = false` on `serverJson`.

### Changed

- Kotlin: generated model checks (constraint decorators, `notBlank`) throw `ModelCheckException`, an
  `IllegalArgumentException` emitted in the models package when a model has a check, instead of calling `require`;
  messages are unchanged. The Ktor server reports only it as `FailedCheck`; any other `IllegalArgumentException` from
  decoding a body (a `decimal` that does not parse, …) is `MalformedBody` and its message is not sent.
- Ktor server: with `error-body: none`, `<svc>Errors()` now also registers the `BadRequestException`,
  `PayloadTooLargeException` and `ContentTransformationException` handlers, answering the status with an empty body,
  so a custom responder receives them too. In 0.2.0 `none` left them to Ktor, which answers a `text/plain` body with
  the exception's message (which can name model classes) and debug-logs them.

### Breaking

- Ktor server: because of the above, with `error-body: none` and `features.status-pages: false`, a hand-written
  `install(StatusPages) { exception<BadRequestException> { … } }` (or `PayloadTooLargeException` /
  `ContentTransformationException`) registered *before* your call to `<svc>Errors()` is now replaced by the
  generated handler for the same exception class (Ktor's rule: the later registration wins for the same class) —
  register yours after `<svc>Errors()` instead, or pass it a `responder`.
- Ktor server: `respondProblem` is now `public` (previously `internal`, and only emitted with `error-body: problem`);
  a function of the same name elsewhere in the server package now clashes with it.
- Ktor server template overrides: `ServerError`, `ServerErrorKind`, `ServerErrorResponder` and the now-always-emitted
  `respondProblem` live in `ServerSupport.kt`, so a 0.2.0 override of `ktor-server/support` no longer satisfies the
  new `ktor-server/errors` template, which needs all four — add them to your override. The `problem` context
  variable `ktor-server/support` used to receive (to gate emitting `respondProblem`) is gone; `ktor-server/errors`
  still receives it, to choose its default responder.

## 0.2.0 — 2026-09-28

Generated output changes for existing specs are listed in the README under
[Upgrading from 0.1.x](README.md#upgrading-from-01x), each with how to restore the old behaviour.

### Breaking

- On/off options moved under a `features:` block (per language emitter and per target); the old keys fail with
  `option-moved` naming the new location: `generics`, Kotlin `validation`, TypeScript `zod`, Ktor server
  `module`, `generate-auth` (now `features.auth`), `call-access`, `nest-routes`, Next.js client `react-query`,
  `server-actions`, `validate`.
- New defaults: Kotlin `features.validation: true`; flat Next.js client `features.react-query: true` (needs
  `@tanstack/react-query`, now an optional peer dependency of `@abhigyakrishna/tspgen-ts-nextjs-client`) and
  `features.validate: true`.
- Peer dependency ranges: `@abhigyakrishna/tspgen-ts-nextjs-client` declares `@tanstack/react-query` `>=5.0.0 <6`
  and `react` `>=18` (both optional), and bounds its optional `zod` peer to `>=4.3.0 <5`.
- For every `@meta` key, an operation or interface now inherits from every namespace enclosing it: Kotlin
  previously stopped inheriting at the service namespace, and TypeScript did not inherit namespace `@meta` onto
  operations or interfaces at all; models, enums and unions still only inherit the `features` key from enclosing
  namespaces.
- `unsupported-in-flat-style`, `validate-requires-zod` and `validate-flat-only` are replaced by the
  `unsupported-feature` warning; the combinations they reported are ignored.
- Kotlin `decimal`/`decimal128` map to `java.math.BigDecimal` by default (`decimal: string` restores `String`); the
  wire stays a JSON string.
- Kotlin `JavaTimeSerializers.kt` / `javaTimeSerializersModule` are renamed `ModelSerializers.kt` /
  `modelSerializersModule`; so is their template, `kotlin/model/java-time-serializers` →
  `kotlin/model/model-serializers` (an override under the old name is ignored).
- Kotlin `uint64` maps to `ULong`.
- TypeScript model-level `readonly` meta moved to `@meta("typescript", #{ features: #{ readonly: true } })`.
- `@encode(string)` on `int64`, `uint64`, `integer` and `safeint` is honoured: the value is a JSON string in both
  languages (TypeScript `string`; Kotlin `LongAsStringSerializer` / `ULongAsStringSerializer`), wherever it
  travels — properties, parameters, whole bodies, `List`/`Map` bodies, typed error bodies, event payloads and
  multipart JSON parts (0.1.x ignored it in both languages and sent numbers). Kotlin bodies whose JSON form their
  type does not carry are (de)serialized with an explicit serializer, bypassing content negotiation's Json: the
  server's `receiveJson`/`respondJson` through `serverJson`, the client through the `<svc>Defaults(format)` Json.
  Other encodings warn `unsupported-encoding`.
- TypeScript `decimal` zod schemas check the number format.
- ts-nextjs-client (grouped): `client/actions/server-client.ts` imports `server-only`; alias it in vitest/jest if
  tests call Server Actions (`features.server-only: false` restores 0.1.x behaviour).
- ts-nextjs-client (flat): `error-class` defaults to `<Service>Error` (the first service's name when there are
  several) instead of `ApiError`, which clashed with a spec model named `ApiError` (`error-class: ApiError`
  restores it).
- ts-nextjs-client (flat): methods' trailing parameter is `RequestOptions`; `ClientOptions.headers` is
  `HeadersInput`; `client.ts` exports `RequestOptions`, `RequestDefaults`, `NextFetchOptions`, `HeadersInput`
  and uses `Omit` (generated types with those names now clash); operations with `@meta` `next` now send it.
- **Ktor server JSON**: one `serverJson` in `ServerSupport.kt` (Ktor's `DefaultJson`, `encodeDefaults = false`;
  public, following `visibility`) for bodies, multipart JSON parts and events, generated with or without the module
  (with `features.module: false`, install `json(serverJson)` in your own `ContentNegotiation`). Unset optional
  properties (and optional ones equal to their default) are omitted instead of written as `null`
  (`features.encode-defaults: true` restores them); required properties with a default are always written
  (`@EncodeDefault(EncodeDefault.Mode.ALWAYS)` on the Kotlin models, which the Ktor client's
  `encodeDefaults = false` Json honours too).
- **Ktor server errors**: `<svc>Errors()` moves to `<Service>Errors.kt` (emitted without the module too), rendered
  by the new `ktor-server/errors` template (a 0.1.x `ktor-server/module` override declaring it now duplicates it);
  unmapped `ApiException`, 400, 413 and 415 answer an RFC 9457 `application/problem+json` body where 0.1.x sent
  Ktor's defaults without one (`error-body: none` restores them). The `detail` is the exception's message; a body
  that does not decode gets `Malformed request body` (plus the missing fields and JSON path when known, never model
  class names or the body), one Ktor cannot read (`ContentTransformationException`) a 415 naming only the content
  type.
- **Ktor client JSON**: `<Service>Json` ignores unknown response keys (`features.ignore-unknown-keys: false`
  restores strict decoding); multipart JSON parts use the `<svc>Defaults(format)` Json.
- **Ktor client requests** set `expectSuccess = false`; `ApiException.message` is a problem body's `detail`.
- **Problem responses in the clients**: an `application/problem+json` error response is never decoded as a declared
  error model (0.1.x decoded it as one: the Ktor client threw a decoding exception, the grouped Next.js client
  returned a wrongly-typed error). The Ktor client throws `ApiException(status, detail)`; the grouped Next.js
  client an `HttpError` whose message is the problem's `detail` (else `title`) and `body` the problem; the flat
  client its error class with that message, `body` `undefined` (with `error-model`) and the new `problem` field
  (a model field named `problem` no longer gets its own error-class field).
- **`auth-header-conflict` from the Next.js clients** is core's `@abhigyakrishna/tspgen-core/auth-header-conflict`
  (was `@abhigyakrishna/tspgen-typescript/auth-header-conflict`, now removed; same message), one code for both
  clients; both now report it on the operation, so `#suppress` works. It also warns when an API key sent in the
  query replaces a query parameter of the same name (both clients).

### Added

- **Next.js client features**: `features.server-only` (grouped; `import "server-only"` in the Server Actions'
  server client, default on), `features.hooks` (both styles; `false` keeps only `queries.ts`),
  `features.error-getters` (flat; the error class's status getters), and `query-key-prefix` (both styles; first
  element of every generated query key).
- **Next.js request options**: per-call `RequestOptions` take every `RequestInit` field but method/body/window,
  plus `headers` and `next`, in both styles; `init` in `ClientConfig`/`ClientOptions` sets client-wide defaults;
  flat `headers` may be a (sync or async) function and per-call `headers` are sent; flat operations honour
  `@meta` `next` like grouped ones. Middleware stays a `fetch` wrapper (README recipe).
- `features:` for every emitter and target, `@meta(scope, #{ features: #{ … } })` per declaration for `docs` and
  `generics`, plugin features (`TspGenPlugin.features`), target features (`Target.features`), `it.features` in
  every template, `features` in plugin, language and target contexts.
- Output hygiene: `features.header` and `header-text` (custom, multi-line banner), `features.docs`,
  `features.api-version`, per-template `features.generics`, TypeScript `features.barrel`, Kotlin
  `visibility: internal` (targets included) and `file-annotations`.
- README Options reference generated by `pnpm docs:options` (kept current by a test).
- Diagnostics `option-moved`, `unknown-feature`, `duplicate-feature`, `unsupported-feature`.
- TypeScript `enum-style` (`union-const`, `union`, `enum`, `const-array`; `enumStyle` meta), `declaration: type`,
  `features.readonly` (declaration override) and `date-type: date` (`Date` via zod codecs in models and both
  Next.js client styles).
- Kotlin `features.enum-unknown` (UNKNOWN fallback member; declaration override) and `scalar-style`
  (`typealias`, `value-class`; `scalarStyle` meta).
- Diagnostics `unsupported-encoding` (core), `unsupported-bounds` (TypeScript).
- Ktor server: `features.status-pages`, `features.ignore-unknown-keys`, `features.encode-defaults`, `error-body`,
  `sse-headers`.
- Ktor client: generated `<Service>Auth` credential providers from `@useAuth` (bearer, basic, OAuth2/OpenID Connect
  tokens, API keys in header, query or cookie; `features.auth`), `features.ignore-unknown-keys`,
  `features.encode-defaults`, `sse-max-size`.
- Core: `auth-header-conflict` warning for the Ktor client; client auth helpers (`authKind`, …) shared by both clients.
- Core: `authQueryConflicts` and `operationTarget` helpers; `auth-header-conflict`'s `parameter` message takes a
  `location` (`header` / `query`).

### Fixed

- Kotlin `uint64` values above 2^63−1 no longer overflow (`ULong`, see Breaking).
- Ktor server: buffered multipart models failing their `require` checks answer 400 instead of 500.
- Ktor server: with java.time types, the module's Json keeps Ktor's `DefaultJson` settings instead of a plain
  `Json` with the serializers module.
- An `@error` model whose body is an explicit non-model `@body` (an array, map/`Record`, or scalar, e.g.
  `@body ids: int64[]`) no longer generates an invalid exception/error class name (Kotlin's `List<Long>` produced
  `ListLong>Exception`; TypeScript's `number[]` produced `Number[]Error`). Kotlin now names it after the body's
  shape (`ListOfLongException`, `MapOfLongException`); TypeScript likewise (`ArrayOfNumberError`,
  `RecordOfNumberError`). Named-model error bodies are unaffected.
- The generated Next.js clients (both styles) type-check under `noPropertyAccessFromIndexSignature`
  (`safeInit`, error factory lookup, the Server Actions' `process.env` base URL).

### For plugin and target authors

- `OperationGroupIR.container` (`"interface" | "namespace"`, new): where a group's `id`/`decorators`/`docs` come
  from — `"namespace"` for operations declared directly in a namespace, with no interface.
- `namespaceDecorators?: DecoratorData[]` on named IR types (models, enums, unions; new), outermost first,
  excluding the global namespace; `OperationGroupIR.namespaceDecorators` likewise now covers the group's whole
  enclosing chain (0.1.x started at the service namespace).
- `Target.features` (a `FeatureSet`, merged into `optionsSchema.properties.features`) and `Target.movedOptions`
  (checked before the target's own options are validated) let a target declare its own on/off gates and renamed
  option keys.
- `FileSpec.features` (per-file feature values on top of the producing target's own; `features` is a reserved
  key in `FileSpec.data`, overwritten by the pipeline).
- `LanguageModule.emitter` (package name, for diagnostics and the default header text), `LanguageModule.features`
  and `LanguageModule.movedOptions`.
- `it.features` (resolved feature values) and `it.ctx.headerText` (the resolved banner text, or `undefined`)
  in every template.
- `BuildOptions.generics` accepts a function (`(declaration: Model) => boolean`), not just a boolean.
- `ApiIR.customScalars: CustomScalarIR[]` (new, required): every distinct user-declared scalar referenced
  anywhere in `services`/`types`, one entry per TypeSpec `Scalar` — every `TypeRef.custom` pointing at the same
  scalar is the very same object, so mutating an entry (e.g. deleting its `docs`) is visible through every
  reference. `CustomScalarIR` gains `namespace`, `root` (the std scalar it ultimately extends),
  `encoding?: "string"` (its own nearest `@encode(string)`, independent of a use's), `constraints?`, `docs?` /
  `deprecated?` (now extends `DocInfo`) and `namespaceDecorators?` (for `@meta` feature overrides, e.g. `docs`).
- `TypeRef` of kind `"scalar"` gains `encoding?: "string"`: `@encode(string)` on `int64`, `uint64`, `integer`,
  `safeint`, `decimal`, `decimal128` (property, then the scalar chain).
- `FeatureNodeKind` (new): the declarations a `features.<key>` override with `override: "declaration"` may sit on
  (namespaces, interfaces, operations, models, enums, unions and scalars), resolved by `ResolvedFeatures.at`.
- Kotlin `KotlinIR.javaTime` / `javaTimeModule` are renamed `serializers` / `serializersModule` (generalized past
  java.time to every class `ModelSerializers.kt` generates a serializer for); new `KotlinIR.ulongAsString?: boolean`
  (`@encode(string)` on `uint64` is used).
- Kotlin `KtDecl` gains a `"value-class"` kind (`KtValueClass`: `scalar-style: value-class`, `@JvmInline value
  class` with `init { require }` checks); user scalars with `scalar-style: typealias` reuse the existing
  `"typealias"` kind (`KtTypeAlias`, previously only for numeric enums and union fallbacks).
- Kotlin `KtTypeUse` gains `underlying?`/`wrapper?: "value-class"` (a typealias/value-class scalar's base type and
  how to wrap/unwrap it), `serializer?`/`serialImports?`/`serialText?` (a scalar's `@encode(string)` serializer,
  and its rendering inside `List`/`Map` elements), `needs?` (generated serializers a typealias needs though it
  doesn't name them), `element?` (a `List`'s item type, for parameter codecs), `value?` (a `Map`'s value type) and
  `generic?` (a generic type's base and arguments).
- Kotlin `KtEnum` gains `unknown?`/`serializerName?` (`features.enum-unknown`: the fallback member name and its
  nested serializer object name).
- Kotlin exports from `@abhigyakrishna/tspgen-kotlin`: `paramDecode`, `paramEncode`, `listElement`,
  `codecImports`, `SERIALIZED_CLASSES`, `serializedIn`, `serializerExpr` / `serializerImports` (an explicit
  `KSerializer` expression for a type use whose JSON form needs one, else undefined) and `isJsonContentType`.
- Ktor server `it.exceptionSerializers` in the `ktor-server/errors` template (exception name → serializer of its
  body, when it needs one); `ktorServerHelpers.respond(status, type, value)` renders the respond statement.
- TypeScript `TsTypeUse` gains `codec?: true` (its schema decodes/encodes, e.g. contains `dateTimeCodec`) and
  `date?: true` (a direct `dateUse` result, so a model literally named `Date` cannot cause a false match).
- TypeScript `TsIR` gains `dateType: "string" | "date"` and `codecsFile?: string` (the module declaring
  `dateTimeCodec`, when some type use is a `Date`).
- TypeScript `TsEnum.style: EnumStyle` (`"union-const" | "union" | "enum" | "const-array"`) and
  `TsInterface.declaration: "interface" | "type"`.
- `unsupported-feature`'s `option` message id (as opposed to `default`, for a `features.<key>` gate): for a
  value-choice option that has no effect given another setting, e.g. `date-type: date` without `features.zod`.

## 0.1.4 — 2026-09-27

Generated output changes for existing specs are listed in the README under
[Upgrading from 0.1.3](README.md#upgrading-from-013), each with how to restore the old behaviour.

### Added

- **Validation in zod schemas.** With `zod: true`, `@minLength`/`@maxLength`, `@pattern`, `@minItems`/`@maxItems`
  and `@minValue`/`@maxValue` refine the schemas of model properties, operation parameters and `@body`
  parameters; `@meta("*" | "typescript", #{ notBlank: true })` rejects blank strings. `@pattern` is compiled with
  the `u` flag when valid; an unparsable pattern is skipped with an `invalid-pattern` warning.
- **Flat client `validate` option.** Checks the body, query object and constrained path parameters with zod before
  `fetch` and rejects with `ZodError`; `undefined`-valued keys are ignored and the original value is sent.
- **Multipart and file uploads** (`@multipartBody` with `HttpPart<T>` parts — text, JSON, file, repeated, `bytes`,
  envelope parts — and `Http.File` bodies) in every target:
  - Ktor server: `multipart: buffered | streaming | raw` (+ per-operation `@meta`), `max-upload-size` with 413,
    400 for missing, duplicated or filename-less file parts.
  - Ktor client: `MultiPartFormDataContent` with Ktor-quoted filenames; file bodies as bytes.
  - Next.js clients: `Blob` file fields sent as `FormData`, declared content types honoured.
- **Generated auth from `@useAuth`** (service, interface, namespace or operation level, `NoAuth`, `A | B`,
  `[A, B]`):
  - Ktor server: `authenticate(...)` wrappers, `auth-providers` to map schemes to provider expressions,
    `generate-auth: false` to opt out; unsupported combinations fail closed.
  - Next.js clients: a `<Service>Auth` credential-provider option (bearer, basic, OAuth2/OpenID Connect tokens,
    API keys in header, query or cookie).
- **TanStack Query hooks for the flat client** (`react-query: true`, off by default): `queries.ts` (keys and
  `queryOptions` factories) and `hooks.ts` (provider, `use<Op>Query`, `use<Op>Mutation` taking one vars object).
  Flat methods take an optional trailing `init?: { signal?: AbortSignal }`.
- **`@typespec/versioning` support.** Generates one version of a `@versioned` service (`version` option, latest by
  default) and an `API_VERSION` constant.
- **Server-sent events.** `SSEStream<Events>` / `text/event-stream` responses: typed `@events` unions, Ktor server
  `sse: text-writer | plugin`, `Flow` in the Ktor client, `AsyncIterable` in the Next.js clients.
- Diagnostics for the new features, e.g. `validate-requires-zod`, `unsupported-multipart-tuple`,
  `unsupported-auth-combination`, `unknown-version`, `unsupported-sse-response`.

### Changed

- Optional properties in zod schemas use `.exactOptional()` so they type-check under `exactOptionalPropertyTypes`;
  **zod ≥ 4.3 is required** (optional peer dependency).
- The flat client passes `fetch` a `Headers` object and lets a request's own `content-type` replace a configured one.
- `Http.File` is a built-in file type (`HttpFile` in Kotlin, `Blob` in TypeScript) instead of a generated `File` model.
- `@typespec/versioning`, `@typespec/streams`, `@typespec/events` and `@typespec/sse` are optional peer dependencies,
  loaded only when a spec uses them.

### Fixed

- The grouped Next.js client type-checks under `exactOptionalPropertyTypes` (request init, optional response headers).
- React Query options for void GET/HEAD operations resolve `null` (TanStack Query v5 rejected `undefined`).
- Flat methods with parameters named like reserved words (`class`) now compile.
- Kotlin `validation: true` applies scalar-level constraints to `Scalar | null` properties.

## 0.1.3 — 2026-09-27

### Added

- Template models are emitted once as generics (`Page<T>`); `generics: false` restores one model per instance.
- Kotlin `date-time` option: `java.time` by default, with generated ISO-8601 serializers and Ktor parameter codecs.
- Kotlin `union-variants` option: single-use sealed-union variants are nested inside the union by default.
- Per-target `output-dir` and `models-output-dir`, with a manifest per directory.
- `notBlank` meta for Kotlin string validation.
- CI: build, typecheck, unit and e2e tests on every push and pull request.

### Changed

- Kotlin enum members get `@SerialName` only when the wire value differs.
- `@minLength(1)` validates `isNotEmpty()` instead of `isNotBlank()`.

## 0.1.2 — 2026-09-27

### Added

- Plugins and targets can be written in TypeScript (loaded through Node's type stripping).

## 0.1.1 — 2026-09-27

- MIT license.

## 0.1.0 — 2026-09-27

Initial release.

- Core: TypeSpec IR, template engine, plugin API and pipeline; `@meta` decorator with scoped metadata.
- Kotlin: models, Ktor server and Ktor client targets, house-style options.
- TypeScript: models and the Next.js client (grouped and flat styles), house-style options.
- Published as `@abhigyakrishna/tspgen-*` on GitHub Packages.
