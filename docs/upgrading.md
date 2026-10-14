# Upgrading

## Upgrading from 0.1.x

0.2.0 is a breaking release. On/off options moved under `features:`; an old key fails with `option-moved`
naming its new location:

| 0.1.x key | 0.2.0 key |
|---|---|
| `generics` (Kotlin, TypeScript) | `features.generics` |
| `validation` (Kotlin) | `features.validation` |
| `zod` (TypeScript) | `features.zod` |
| `module` (Ktor server) | `features.module` |
| `generate-auth` (Ktor server) | `features.auth` |
| `call-access` (Ktor server) | `features.call-access` |
| `nest-routes` (Ktor server) | `features.nest-routes` |
| `react-query` (Next.js client) | `features.react-query` |
| `server-actions` (Next.js client) | `features.server-actions` |
| `validate` (Next.js client) | `features.validate` |

New defaults change generated output:

| Change | Restore 0.1.x behaviour |
|---|---|
| Kotlin `features.validation` defaults to true: models with constraint decorators get `init { require(...) }` checks, so constructing or deserializing a value that violates a constraint throws `IllegalArgumentException` (the Ktor server answers such bodies with an error) | `features: { validation: false }` |
| Flat Next.js client: `features.react-query` defaults to true, adding `queries.ts` and `hooks.ts` (and `export * from "./queries"` in `index.ts`); they import `@tanstack/react-query` (now an optional peer dependency) and `react` | `features: { react-query: false }` on the target (projects without TanStack Query) |
| Flat Next.js client: `features.validate` defaults to true: with `features.zod` on, methods check body, query object and constrained path parameters with zod before `fetch` and reject with `ZodError` (checked methods become `async`) | `features: { validate: false }` on the target |
| `server-actions: true` with the flat style, `validate: true` without zod, and `validate: true` with the grouped style were errors (`unsupported-in-flat-style`, `validate-requires-zod`) or a `validate-flat-only` warning; they are now ignored with an `unsupported-feature` warning, and those three diagnostics are gone | none |
| A `features` key in `@meta` is now read and validated (`invalid-meta`); it used to pass through untouched | rename the key |
| For every `@meta` key (not only `features`), an operation or interface now inherits from every namespace enclosing it: Kotlin previously stopped inheriting at the service namespace, and TypeScript did not inherit namespace `@meta` onto operations or interfaces at all; models, enums and unions still only inherit the `features` key from enclosing namespaces | scope the meta to the declaration itself (or the narrowest namespace that should apply) |
| Kotlin `decimal`/`decimal128` are `java.math.BigDecimal` (generated `BigDecimalSerializer`, `@file:UseSerializers`); the wire is still a JSON string | `decimal: string` |
| Kotlin `JavaTimeSerializers.kt` / `javaTimeSerializersModule` are now `ModelSerializers.kt` / `modelSerializersModule`; hand-written `Json { serializersModule = javaTimeSerializersModule }` must be renamed | none (rename the reference) |
| Kotlin `uint64` is `ULong` (was `Long`, which overflowed above 2^63−1); parameters use `toULong()` | none (`@Kotlin.type("kotlin.Long")` on the property) |
| TypeScript model-level `@meta("typescript", #{ readonly: true })` is ignored with `invalid-meta` | `@meta("typescript", #{ features: #{ readonly: true } })` |
| `@encode(string)` on `int64`/`uint64`/`integer`/`safeint` now makes the value a JSON string in both languages (TypeScript `string`, Kotlin `LongAsStringSerializer`/`ULongAsStringSerializer`) wherever it travels — properties, parameters, whole bodies, `List`/`Map` bodies, typed error bodies, event payloads, multipart JSON parts; 0.1.x ignored it and sent a number. Kotlin bodies whose JSON form their type does not carry bypass content negotiation's Json (server: `serverJson`; client: the `<svc>Defaults(format)` Json) | remove `@encode(string)` |
| Other `@encode` encodings (`unixTimestamp`, `rfc7231`, `base64url`, …) warn `unsupported-encoding` (0.1.x ignored them silently); the output is unchanged | none |
| TypeScript `decimal` schemas check the number format (`z.string().regex(…)`): the grouped client rejects non-numeric decimal strings in responses | `validate: false` in `ClientConfig` — does not help a `date-type: date` response that also carries a date: its codec schema always runs, decimal check included |
| Grouped `client/actions/server-client.ts` starts with `import "server-only";`. Next.js resolves it; test runners that run Server Actions outside Next.js (vitest, jest) must alias `server-only` to an empty module, and a `tsc` without Next's types (`"types": ["next"]`) needs `declare module "server-only";` | `features: { server-only: false }` on the ts-nextjs-client target |
| Flat methods' trailing parameter is `init?: RequestOptions` (every `RequestInit` field but method/body/window, plus `headers` and `next`) instead of `init?: { signal?: AbortSignal }`; `{ signal }` calls are unchanged, but code relying on the exact type (`Parameters<typeof api.readNode>`) sees the wider one | none (wider type) |
| Flat `ClientOptions.headers` is `HeadersInput` (static `HeadersInit` or a sync/async function called per request) instead of `Record<string, string>`; plain objects still type-check | none |
| The flat client's error class defaults to `<Service>Error` (e.g. `PetStoreError`; the first service's name when a spec has several) instead of `ApiError`, which clashed with the common spec model `ApiError` | `error-class: ApiError` on the target |
| Flat `client.ts` exports `RequestOptions`, `RequestDefaults`, `NextFetchOptions` and `HeadersInput`, and uses `Omit`: a generated type with one of these names now fails with `flat-client-name-clash` | rename it with `@TS.name` |
| Flat operations with `@meta(…, "typescript:ts-nextjs-client", #{ next })` now send `next` to fetch (0.1.x ignored it in the flat style) | remove the meta |
| Flat per-call `headers` override `@useAuth` credentials, and a per-call `accept` header wins over a stream's `text/event-stream` | none |
| Grouped `RequestOptions` accepts every `RequestInit` field (0.1.x: `next`, `cache`, `signal`, `headers`) and both styles take `init` defaults | none |
| Ktor server responses and events omit unset optional properties (and optional properties equal to their default) instead of writing `"field": null`; clients that required the explicit `null` are affected. Required properties with a default are still written (`@EncodeDefault(EncodeDefault.Mode.ALWAYS)`) | `features: { encode-defaults: true }` on the Ktor server target |
| Unmapped `ApiException`, 400, 413 and 415 responses from the Ktor server carry an RFC 9457 `application/problem+json` body where 0.1.x sent Ktor's defaults without one (clients asserting an empty body are affected); a body that does not decode gets the detail `Malformed request body` (with the missing fields / JSON path, never model class names or the body), one Ktor cannot read (unsupported content type) a 415 naming only the content type | `error-body: none` on the Ktor server target (since 0.2.1, `none` answers status-only and no longer falls back to Ktor's own defaults, which send a `text/plain` body with the exception's message) |
| Buffered multipart models failing their `require` checks answer 400 instead of 500 | none (bug fix) |
| `serverJson` (public; `internal` with `visibility: internal`) is generated in `ServerSupport.kt` with `features.module: false` too; a hand-written `serverJson` in the server package now clashes | rename yours |
| `<svc>Errors()` moves from `<Service>Module.kt` to `<Service>Errors.kt` (same package and name) and is emitted with `features.module: false` too; a hand-written `<svc>Errors` in the same package now clashes | rename yours |
| Template override: `<svc>Errors()` is rendered by the new `ktor-server/errors` template, no longer by `ktor-server/module`; a 0.1.x `ktor-server/module.eta` override still declaring it now duplicates it (conflicting overloads) | drop it from your `module.eta` (override `ktor-server/errors` instead) |
| Template override: `kotlin/model/java-time-serializers` is renamed `kotlin/model/model-serializers`; a 0.1.x override under the old name is silently ignored | rename your override file (and `javaTimeSerializersModule` → `modelSerializersModule` in it) |
| With java.time types, the server module's Json keeps Ktor's `DefaultJson` settings (lenient decoding, …) instead of plain `Json` + serializers module | none |
| The Ktor client ignores response fields the models don't declare (`<Service>Json`); code expecting `SerializationException` on extra fields is affected | `features: { ignore-unknown-keys: false }` on the Ktor client target |
| Ktor client multipart JSON parts are encoded with the Json passed to `<svc>Defaults(format)` (was an internal default) | pass a `format` that suits parts too |
| An `application/problem+json` error response is no longer decoded as the operation's declared error model: the Ktor client throws `ApiException(status, detail)`, the grouped Next.js client an `HttpError` (message: the problem's `detail`, else `title`), the flat client its error class with `body` `undefined` (with `error-model`) and the new `problem` field; a model field named `problem` no longer gets its own flat error-class field | none (read `problem` / `body`) |
| Generated Ktor client requests set `expectSuccess = false`, so typed exceptions are thrown even on clients built with `expectSuccess = true` (instead of Ktor's `ClientRequestException`) | none |
| `<Service>ApiClient` / `<Group>Client` gain an optional trailing `auth` parameter for APIs with `@useAuth` (only reflection or positional callers passing extra arguments notice) | `features: { auth: false }` on the Ktor client target |
| The internal `partJson` / `sseJson` (server and client) and `defaultSseJson` (client) are replaced by `serverJson` / `apiJson`; hand-written code in the same module using them breaks | use `serverJson` or `<Service>Json` |

Known limitations:

- A `features.docs: false` override on a namespace, interface, operation or model does not reach anonymous
  inline models nested inside it (e.g. an inline object response or property type); use the global
  `features.docs: false` to cover them too.
- `language:target` scope `@meta` features (e.g. `@meta("kotlin:ktor-server", #{ features: #{ … } })`) are not
  applied to `docs` or `generics`: the IR they act on is shared across every target of a language.
- `features.generics` can be overridden with `@meta` only on namespaces and models, not on interfaces,
  operations, enums or unions.

## Upgrading from 0.1.3

| Change | Restore 0.1.3 behaviour |
|---|---|
| A `@versioned` service generates only the chosen version (the latest by default), where 0.1.3 merged every version into one output | set `version` to the version you need; there is no merged-output mode |
| zod schemas include constraint decorators, so the grouped client rejects responses that violate them | `validate: false` in `ClientConfig` (turns off response validation) |
| Optional properties use `.exactOptional()`: a present key with value `undefined` fails response/model parsing (request checks drop such keys first) | omit the key instead |
| Server Action input violating constraint decorators returns `{ ok: false, status: 400 }` instead of calling the API | none (`validate: false` only covers response parsing) |
| Kotlin `validation: true` also checks scalar-level constraints on `Scalar \| null` properties | `validation: false`, or move the constraint off the scalar |
| Generated zod schemas use `.exactOptional()`, so zod ≥ 4.3 is required (declared as an optional peer dependency) | none (upgrade zod) |
| `notBlank` in scope `*` now also affects TypeScript | scope it to `kotlin` |
| `Http.File` bodies and multipart operations previously generated broken output: `Http.File` was emitted as a plain model (`File`) and multipart/file bodies were JSON-encoded regardless of target; both now generate working uploads (see [Uploads](uploads.md)) | none (the previous output could not upload) |
| The flat client no longer rejects an operation for having a multipart or file body (`flat-client-unsupported`), and the `non-json-body` warning no longer fires for one | none |
| Specs using `@useAuth` get `authenticate(...)` route wrappers on the Ktor server (providers named after the scheme ids, see [Authentication](authentication.md)); a route whose `wrap` meta already calls `authenticate(...)` gets both, and then accepts either provider | `generate-auth: false` on the Ktor server target |
| `ServerOpExtras` (routes template data `extras[op.id]`): `authenticate` still lists the provider names of the route's `authenticate(...)` wrapper, now also those generated from `@useAuth` (the scheme ids); the full wrapper call is in the new `auth` (and `authProviders`, `authStrategy`, `authOptional`). A plugin routing style or overridden routes template rendering `authenticate` alone keeps routes protected, but loses `strategy`/`optional`/`auth-providers` expressions: warning `auth-wrapper-not-rendered` | render `extras[op.id].auth[0]` as the wrapper, or `generate-auth: false` |
| Specs using `@useAuth` get a `<Service>Auth` type and `auth` option in the Next.js clients (`ClientConfig<Auth>` / `ClientOptions<Auth>` become generic); in the flat client a model named `<Service>Auth`, `AuthScheme`, `AuthEntries`, `resolveAuth` or `base64`, or an operation named `auth`, is now a clash | none needed for the runtime (no `auth` → no credentials added); rename clashing names with `@TS.name` |
| Every flat client method has a new optional trailing parameter `init?: { signal?: AbortSignal }` (after the query object; named `requestInit`/`options`/`init2`… when a parameter already uses `init`), and `fetch` gets `signal` when one is passed; positional calls are unaffected, but code relying on the exact parameter list (e.g. `Parameters<typeof api.readNode>`, wrappers spreading `...args`) sees the extra parameter | none (ignore the parameter) |
| A flat method whose path parameter or body is named like a reserved word (`class`) — previously an invalid signature — now names it `classValue` | none (the previous output did not compile) |
| A generated type named `AbortSignal` is reported as a flat-client name clash (`flat-client-name-clash`), since the new `init` parameter uses the global | rename it with `@TS.name` |
| The grouped client's React Query options for void GET/HEAD operations resolve `null` instead of `undefined` (which TanStack Query v5 rejects, so those queries always failed); their hook data type is `null` | none (the previous queries could not succeed) |
| `react-query: true` with `client-style: flat` generates `queries.ts` and `hooks.ts` instead of failing with `unsupported-in-flat-style` (unset or `false` still generates neither) | leave `react-query` unset |
| The flat client (JSON-only APIs too) passes fetch a `Headers` object (`new globalThis.Headers(options.headers)`) instead of a plain object, and its JSON `content-type` replaces a `Content-Type` from `ClientOptions.headers` in any letter case; a custom `fetch` reading `init.headers` as a plain object (`init.headers["authorization"]`) must read it through `new Headers(init.headers).get(…)` | none (adapt the custom fetch) |
| A `text/event-stream` response is now a server-sent event stream: previously its body was read as one string (Kotlin `String`, TypeScript `string` or rejected by the flat client); now the Ktor server takes a `Flow`, the Ktor client returns a `Flow` and the Next.js clients return `AsyncIterable`s (see [Server-sent events](server-sent-events.md)) | none (declare a `text/plain` response to keep a single string) |
| `@events` unions (with the optional `@typespec/events` installed) are generated as events types — Kotlin `sealed interface` of event classes, TypeScript `{ event, data }` unions — instead of plain unions (previously `JsonElement` / enum typealiases in Kotlin, value unions in TypeScript) | none |
| `@abhigyakrishna/tspgen-core` declares `@typespec/streams`, `@typespec/events` and `@typespec/sse` as optional peer dependencies; package managers that install peers automatically may add them | none (they are only loaded, never required) |

## Upgrading from 0.1.2

0.1.3 changes generated output by default; each change has an option restoring the old behaviour.

| Change | Restore 0.1.2 output |
|---|---|
| Template models are generic (`Page<T>`) instead of one model per instance (`PagePet`) | `generics: false` |
| Kotlin date/time types come from `java.time`, with generated serializers | `date-time: kotlin.time` |
| Single-use sealed-union variants are nested (`NodeSource.Catalog`) | `union-variants: top-level` |
| Kotlin enum members get `@SerialName` only when the wire value differs | — (serialization unchanged) |
| `@minLength(1)` validates `isNotEmpty()`, no longer `isNotBlank()` | add `@meta("kotlin", #{ notBlank: true })` |
