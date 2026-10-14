# Kotlin

Configure the Kotlin emitter in `tspconfig.yaml`:

```yaml
emit:
  - "@abhigyakrishna/tspgen-kotlin"
options:
  "@abhigyakrishna/tspgen-kotlin":
    package: "com.acme.pets"            # base package (default "generated")
    packages:                           # TypeSpec namespace → Kotlin package (longest prefix wins)
      - { namespace: "PetStore.Admin", package: "com.acme.admin" }
    errors: typed                       # typed | thrown (error responses documented only; you throw your own)
    features:                           # on/off gates; every key with its default: Options reference
      validation: true                  # constraint decorators → init { } checks (default true)
    targets:
      - "@abhigyakrishna/tspgen-kotlin-ktor-server":
          output-dir: ./gen/server      # optional, any target: write its files elsewhere
          routing-style: dsl            # dsl | resources | <plugin-registered>
          auth-providers:               # auth scheme id → Kotlin expression naming the Ktor provider
            BearerAuth: JWT_AUTH
          features:
            module: true                # false: no <Service>Module.kt
      - "@abhigyakrishna/tspgen-kotlin-ktor-client": {}
```

All options, with kinds and defaults, are listed in [Options reference](options.md).

`packages` is a list, not a map (TypeSpec rejects dots in `tspconfig` option keys): the longest matching
namespace prefix wins, `@Kotlin.packageName` on a type wins over `packages`, and anonymous inline types
(no namespace) always go to `<package>.models`. On the Ktor server target, the same mapping applies per
service/routes unit (see `grouping` below): a unit lands in its groups' mapped package only when every
group in it maps to the same one, otherwise it falls back to the target package.

Output (inside the emitter output dir):

```
models/<pkg>/models/…   data classes, enums, sealed interfaces           (shared)
models/<pkg>/api/…      <Op>Result sealed types, <Error>Exception types   (shared)
server/<pkg>/server/…   <Group>Service, <Group>Routes, <Service>Module, ServerSupport
client/<pkg>/client/…   <Group>Client, <Service>ApiClient, ClientSupport
.generated-manifest.json
```

Re-emitting deletes only files listed in the previous manifest; hand-written files are never touched.
Implement the generated `…Service` interfaces outside the output directory.

`models-output-dir` (language option) and `output-dir` (any target's options) move those files to another
directory, e.g. models into a shared contract module and routes into the feature module. Paths are relative
to the project root and may use `{project-root}` / `{emitter-output-dir}`; paths inside each directory are
unchanged (`models/…`, `server/…`), and every directory gets its own `.generated-manifest.json` with an entry
per emitter, so the Kotlin and TypeScript emitters can share a directory. A directory a target no longer
writes to is cleaned up on the next run. The Next.js client rewrites its imports of the models when they live
elsewhere (other TypeScript targets: see `TargetContext.modelsOutputDir`).

**Generics.** A template model is generated once as a generic class and every use passes its arguments:
`model Page<T> { items: T[]; total: int64 }` → `data class Page<T>(val items: List<T>, val total: Long)` and
`Page<Pet>` at each use (TypeScript: `interface Page<T>`, with zod a `PageSchema(itemSchema)` function). A
template that needs per-instance models — a base model or `@discriminator`, HTTP metadata, `...T` spreads, a `Record` spread of a type parameter (`...Record<T>`),
`@friendlyName`, or a type parameter inside an inline model or union (`meta: { first: T }`, `T | string`) —
still gets one model per instance (`PagePet`), as does a template used directly as a variant of a
discriminated union, and everything with `features.generics: false` (per template: `@meta("kotlin", #{ features: #{ generics: false } })`).
Per-instance names join every argument level: `Page<Box<Cat>>` → `PageBoxCat`, `Maybe<Maybe<int32>>` → `MaybeMaybeInt32`.

**Date and time.** With `date-time: java.time` (the default) `utcDateTime`, `offsetDateTime`, `plainDate`,
`plainTime` and `duration` map to `java.time.Instant`, `OffsetDateTime`, `LocalDate`, `LocalTime` and
`Duration`. kotlinx.serialization has no serializers for them, so `models/<pkg>/models/ModelSerializers.kt`
holds ISO-8601 serializers for the ones in use (a java.time class is written qualified, e.g.
`java.time.Duration`, when a generated type has the same name) and each model file using them declares
`@file:UseSerializers(...)`; Ktor parameters and headers of these types use `X.parse` / `toString()`. The
same file also holds `BigDecimalSerializer` / `ULongAsStringSerializer` when decimals or string-encoded
`uint64` are used — generated with `date-time: kotlin.time` too, since neither depends on the date-time
option — and declares `modelSerializersModule`, which the server's `serverJson` and the client's `<Service>Json`
include so bodies that are java.time values themselves (`List<Instant>`) work; with `features.module: false`,
install `json(serverJson)` (or your own Json with `serializersModule = modelSerializersModule`) in your own
`ContentNegotiation`.

**Sealed unions.** A `@discriminated(#{ envelope: "none" })` union of models becomes a sealed interface. A
variant model nothing else references is declared inside it, named after its variant key
(`union NodeSource { catalog: CatalogSource }` → `NodeSource.Catalog`, or `@Kotlin.name` on the model);
variants used elsewhere stay top-level. `union-variants: top-level` keeps every variant in its own file.

## Server

```kotlin
fun Application.module() = petStoreModule(MyPetsService())   // installs JSON, StatusPages, routing
```

Or compose it yourself: `routing { petStoreApiRoutes(pets) }` and `install(StatusPages) { petStoreErrors() }`.
Throw a generated `…Exception` (e.g. `NotFoundException(NotFound("…"))`) to send a typed error response.

**JSON.** Requests, responses, multipart JSON parts and event payloads share `serverJson` (`ServerSupport.kt`,
public, `internal` with `visibility: internal`): Ktor's `DefaultJson` with `encodeDefaults = false` — unset optional properties (and optional properties
equal to their default) are omitted instead of written as `null`, matching the TypeScript models and zod schemas —
plus the models' serializers. Required properties with a default are always written
(`@EncodeDefault(EncodeDefault.Mode.ALWAYS)` on the model), since the other languages' models require them. `features.encode-defaults: true` writes them again; `features.ignore-unknown-keys: true`
accepts request fields the models don't declare (default: 400). `serverJson` is generated with or without the
module; with `features.module: false`, install `json(serverJson)` in your own `ContentNegotiation` to keep the same
wire format. A body whose JSON form its Kotlin type does not carry — an `@encode(string)` `int64`/`uint64` scalar
(inline or typealias) as the whole body, or inside a `List`/`Map` (`List<Long>`), which `call.receive<T>()` and
`call.respond` would write as numbers — is read and written through `serverJson` with an explicit serializer
(`receiveJson`/`respondJson` in `ServerSupport.kt`, e.g. `ListSerializer(LongAsStringSerializer)`), whatever Json
your content negotiation installs; typed error bodies, JSON event payloads and multipart JSON parts get the same
serializer. Such a request body with a non-JSON content type answers 415.

**Errors.** `<Service>Errors.kt` declares `StatusPagesConfig.<svc>Errors(responder)`: typed `…Exception`s answer their
status and error body; every other error the generated routes raise — any other `ApiException`,
`BadRequestException` (missing or unparsable parameters, request bodies that fail to decode or fail a model check),
`PayloadTooLargeException` and `ContentTransformationException` (an unsupported content type) — goes to `responder`
as a `ServerError` (`status`, `detail`, `kind`, `cause`). The default responder answers an RFC 9457
`application/problem+json` body — `{"type":"about:blank","title":"Bad Request","status":400,"detail":"name must not be blank"}`;
with `error-body: none` it answers the status without a body.

`detail` is safe to send: the message of a missing or unparsable parameter, a multipart check or a failed model check
(`ModelCheckException`); `Malformed request body` plus the fields missing and the JSON path when known for a body that
does not decode (`Malformed request body: missing 'name'`), a value its serializer rejects (`"abc"` for a `decimal`)
included; `Content type … is not supported` for a 415. kotlinx's own messages
name model classes and echo the request body, so don't build messages from `cause.message`. `kind` is one of
`MissingParameter`, `InvalidParameter`, `MalformedBody`, `FailedCheck`, `PayloadTooLarge`, `UnsupportedMediaType`,
`ApiException`. Kinds and `ServerError` fields may be added in later releases: keep an `else` branch in a `when` over
`kind`.

To answer in your own error model:

```kotlin
install(StatusPages) {
    shopErrors { error ->
        respond(error.status, ErrorResponse(error.status.value, codeOf(error.kind), error.detail, callId))
    }
}
```

(`callId` needs the `CallId` plugin installed; drop it, or use whatever request id your app already carries, if you
don't install one.)

Your own `install(StatusPages)` — in another module, or with `features.errors: false` (no `<Service>Errors.kt`, and
no StatusPages dependency) — can classify the same errors with `call.serverErrorOf(cause)` (null for exceptions the
generated server doesn't raise) and answer problem+json with `call.respondProblem(status, detail)`.

The module installs StatusPages with `<svc>Errors()`; `features.status-pages: false` leaves StatusPages to you (call
`<svc>Errors()` in your own `install(StatusPages) { … }`). Handlers registered after `<svc>Errors()` replace the
generated one for the same exception class. A buffered multipart model whose `init { }` check fails answers 400,
not 500. `IllegalArgumentException` is not mapped globally: thrown by a service, it is still a 500.

## Client

```kotlin
val http = HttpClient(CIO) { petStoreDefaults() }             // JSON content negotiation (PetStoreJson)
val api = PetStoreApiClient(http, "https://api.example.com", PetStoreAuth(bearerAuth = { tokens.current() }))
val pet = api.pets.get(petId = 1)                             // typed errors are thrown as …Exception
```

`<Service>Json` (`PetStoreJson`) ignores response fields the models don't declare (`features.ignore-unknown-keys`,
default true), so a server adding a field doesn't break deployed clients. Derive your own with
`Json(PetStoreJson) { prettyPrint = true }` and pass it to `petStoreDefaults(format)`; bodies, multipart JSON parts
and event payloads all use it. Bodies whose JSON form their Kotlin type does not carry (an `@encode(string)` `int64`
as the whole body or in a `List`/`Map`, see the server) are written as text and read from the body text with an
explicit serializer and that Json, not through content negotiation; so are such typed error bodies, event payloads
and multipart JSON parts. Generated calls set `expectSuccess = false` on their request, so typed error mapping
also works on a client built with `expectSuccess = true`. An error response without a declared body throws
`ApiException(status, message)`; the message is a problem body's `detail` (what the generated server sends), else
the body text. An `application/problem+json` response throws that `ApiException` too, even at a status with a
declared error model: a problem is never decoded as the model. `sse-max-size` (bytes, default 1 MiB) limits event lines and data.
