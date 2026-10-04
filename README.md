# tspgen — multi-language SDK emitters for TypeSpec

Generate models, server stubs and typed clients from one [TypeSpec](https://typespec.io) definition.
The core is language-neutral; languages and server/client libraries plug in as separate packages.

| Package | Role |
|---|---|
| `@abhigyakrishna/tspgen-core` | TypeSpec → language-neutral IR, layered Eta templates, plugin API, pipeline, output manifest |
| `@abhigyakrishna/tspgen-kotlin` | The TypeSpec emitter for Kotlin: kotlinx.serialization models, result/error types, `@Kotlin.*` decorators |
| `@abhigyakrishna/tspgen-kotlin-ktor-server` | Target: Ktor server — service interfaces, routing, module with JSON + StatusPages |
| `@abhigyakrishna/tspgen-kotlin-ktor-client` | Target: Ktor `HttpClient` SDK |
| `@abhigyakrishna/tspgen-typescript` | The TypeSpec emitter for TypeScript: interfaces, literal-union enums, optional zod schemas, result/error types, `@TS.*` decorators |
| `@abhigyakrishna/tspgen-ts-nextjs-client` | Target: Next.js client SDK — typed `fetch` client, TanStack Query hooks, Server Actions |
| `@abhigyakrishna/tspgen-go` | Go emitter: JSON models in their own Go module (initial implementation) |
| `@abhigyakrishna/tspgen-go-nethttp-client` | Target: Go `net/http` client in its own module (initial implementation) |
| `@abhigyakrishna/tspgen-go-nethttp-server` | Target: Go `net/http` server in its own module (initial implementation) |
| `@abhigyakrishna/tspgen-go-gin-server` | Target: Gin server in its own module, with service interfaces and route registration |

## Usage

```bash
npm install -D @typespec/compiler @typespec/http @abhigyakrishna/tspgen-kotlin \
  @abhigyakrishna/tspgen-kotlin-ktor-server @abhigyakrishna/tspgen-kotlin-ktor-client
# TypeScript: the emitters, plus the generated code's runtime dependencies (zod with features.zod; TanStack Query
# and React for the query hooks)
npm install -D @abhigyakrishna/tspgen-typescript @abhigyakrishna/tspgen-ts-nextjs-client
npm install zod @tanstack/react-query react
```

`tspconfig.yaml`:

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

All options, with kinds and defaults, are listed in [Options reference](#options-reference).

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
template that needs per-instance models — a base model or `@discriminator`, HTTP metadata, `...T` spreads,
`@friendlyName`, or a type parameter inside an inline model or union (`meta: { first: T }`, `T | string`) —
still gets one model per instance (`PagePet`), as does a template used directly as a variant of a
discriminated union, and everything with `features.generics: false` (per template: `@meta("kotlin", #{ features: #{ generics: false } })`).

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

### Server

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

### Client

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

### Go

The Go emitter generates three independent Go modules using explicit import paths. It defaults to Go 1.22
for `http.ServeMux` method and path patterns. The client and server modules have local `replace` directives
pointing to the generated models module; change those directives when publishing the modules separately.

```yaml
emit:
  - "@abhigyakrishna/tspgen-go"
options:
  "@abhigyakrishna/tspgen-go":
    module: example.com/pets/models
    targets:
      - "@abhigyakrishna/tspgen-go-nethttp-client":
          module: example.com/pets/client
      - "@abhigyakrishna/tspgen-go-nethttp-server":
          module: example.com/pets/server
```

Generated files are under `models/`, `client/`, and `server/`, each with its own `go.mod`. The supported HTTP
subset is one fixed-status JSON success response per operation, JSON request bodies, and scalar path, query,
and header parameters. The client returns a typed success body or `HTTPError`; the server generates a `Service`
interface, `RegisterRoutes`, and `NewHandler`. Unsupported shapes, including auth, streaming, multipart, multiple success
responses, response headers, collection parameters, union-typed parameters, and nested discriminated models, produce TypeSpec diagnostics.

#### Configuration

Models and every Go HTTP target have explicit options and feature gates, listed in the [Options reference](#options-reference).
This expanded example shows the available settings; select either the net/http or Gin server target for each output directory.

```yaml
emit:
  - "@abhigyakrishna/tspgen-go"
options:
  "@abhigyakrishna/tspgen-go":
    module: example.com/pets/models
    package: models
    go-version: "1.27"
    layout: per-type                   # single-file | per-type | per-namespace
    naming:
      initialisms: [ID, HTTP, URL]      # preserve these initialisms in exported names
      enum-members: PascalCase         # PascalCase | UPPER_SNAKE
      operation-prefix: group          # group | none
    type-names:
      Pets.Pet: PetModel                # qualified type id wins over an unqualified name
    date-time: time.Time               # string | time.Time (UTC/offset timestamps only)
    decimal: json.Number               # json.Number | string | float64
    integer: json.Number               # json.Number | int64 (unbounded integer only)
    scalar-style: alias                # inline | alias
    optional-fields: pointers          # pointers | values (model properties only)
    features:
      header: true
      docs: true
      api-version: true
      generics: true                    # generic model types; independent of generic methods
      validation: true
      validator: false                 # opt in to go-playground/validator/v10 struct tags
      defaults: true
      omit-empty: true
      enum-unknown: false
      go-mod: true
    targets:
      - "@abhigyakrishna/tspgen-go-nethttp-client":
          module: example.com/pets/client
          package: client
          go-version: "1.27"           # optional: inherits models version
          grouping: per-interface      # single-file | per-interface | per-namespace
          client-name: Client
          request-suffix: Request
          errors: typed                # raw | typed
          max-response-size: 1048576
          timeout-ms: 0                # 0 uses http.DefaultClient
          features:
            go-mod: true
            client-constructor: true
            generic-methods: true      # opt-in, requires effective Go version >= 1.27
            validate: false
            ignore-unknown-keys: true
            encode-defaults: false
            explicit-nulls: true
      - "@abhigyakrishna/tspgen-go-gin-server":
          module: example.com/pets/server
          package: server
          go-version: "1.27"           # Gin minimum: 1.25.0; net/http minimum: 1.22
          grouping: per-interface
          service-name: Service
          request-suffix: Request
          handler-shape: request-object # request-object | params
          errors: typed
          max-body-size: 1048576
          error-body: problem           # json | problem | none
          features:
            go-mod: true
            handler: true              # false retains RegisterRoutes
            call-access: false         # *gin.Context, or *http.Request for net/http
            validate: true
            ignore-unknown-keys: false
            encode-defaults: false
            explicit-nulls: true
```

The net/http server accepts the same server settings. Each target's `go-version` inherits the models version
and applies its runtime minimum; an explicit target version below either minimum is rejected. Turning off
`features.go-mod` lets an application manage that module's dependencies. Shared emitter options such as
`template-dir`, `plugins`, `header-text`, `models-output-dir`, and per-target `output-dir` also apply.

Model layouts and HTTP grouping organize files within one configured Go package. Grouped servers expose a
service interface per group and embed those interfaces in the root service. Type names, field names, enum
constants, and operation names follow the emitter's naming configuration; conflicting generated identifiers
produce diagnostics. `scalar-style: alias` emits Go aliases for referenced user scalars, retaining their wire codecs.
HTTP parameters always preserve optional presence, even with `optional-fields: values` for model properties.
net/http routes match exact paths, including root and trailing-slash routes. Router conflicts are reported during
generation, including equivalent wildcard routes and overlapping paths without an unambiguous precedence.

With validation enabled, generated model `Validate` methods check bounds, lengths, patterns, collection sizes,
literals, and enums. `models.ValidateValue` also walks nested models and generic instances. Validation
retains the nullability of generic type arguments, including collection elements. The `integer`
scalar rejects fractional values and quoted numbers while preserving arbitrarily large integer text.
Server request decoding checks required properties and nullability before calling the service. Client validation is opt-in and
checks outgoing requests and decoded responses. `features.validation: false` disables these contract checks;
JSON syntax, scalar width, body limits, and media types are still enforced. `@meta("go", #{ features: #{ validation: false,
defaults: false } })` can override those model features for a namespace or individual model.

`features.validator: true` adds `validate` struct tags for
[go-playground/validator/v10](https://github.com/go-playground/validator), independently of
`features.validation`. It defaults to false and supports namespace/model overrides with
`@meta("go", #{ features: #{ validator: true } })`. The generated module adds no dependency;
install the validator in your application and pass generated models to your own instance:

```go
validate := validator.New(validator.WithRequiredStructEnabled())
err := validate.Struct(pet) // pet is a generated model; import github.com/go-playground/validator/v10
```

Tags cover string lengths, collection sizes, numeric bounds representable in native Go numeric types,
literals, enums, and nested models/collections (`dive`). Optional pointers and nullable values use
`omitnil`; optional value fields use `omitempty`, so their zero values skip tag checks. Required pointers,
slices and maps use `required`; required scalar fields accept zero values unless a declared constraint
excludes them. Regex patterns, bounds on `json.Number`/string decimals, literals containing `0x2C` or
`0x7C`, JSON property presence, and generic argument shapes still require the generated
`Validate`/`ValidateValue` and decoding checks. HTTP targets continue to use those generated checks.

Defaults initialize missing JSON properties and generated `New<Type>()` constructors. `encode-defaults: false`
omits optional properties equal to their declared defaults; `true` includes them and unset optional properties.
`explicit-nulls: false` omits null model properties, including required nullable properties, while preserving
null collection elements. Value fields use Go zero values for absence; pointers retain presence of zero values.
`enum-unknown: true` maps unknown string enum values to an `UNKNOWN` sentinel; validation accepts it, but
serialization rejects it. Fixed-width numbers retain their widths; `json.Number` preserves numeric text,
`decimal: string` uses JSON strings, and `decimal: float64` can lose precision.

`errors: typed` adds an error type per declared error response, such as `PetsRead404Error` with a typed `Body`.
Clients retain the underlying `HTTPError` through `Unwrap`, so `errors.As` works for both types. Servers accept
these typed errors or `HTTPError`, including wrapped errors. `error-body` controls generated handler failures
and sanitized internal errors: JSON `{error}`, RFC 9457 `application/problem+json`, or no body. Explicit service
error bodies retain their JSON representation. Client response limits apply to success and error bodies;
`timeout-ms` applies when `HTTPClient` is nil, and an application-supplied client takes precedence.

#### Generic client methods (Go 1.27+)

`features.generic-methods: true` generates `Client.Do[T any]`, which typed endpoint methods use to decode their
success responses. A client targeting Go 1.26 or older rejects this option. Go 1.27 with the option disabled
still emits the ordinary transport implementation. Generic model types remain controlled separately by the
emitter's `features.generics`; disabling it emits concrete model instances.

```go
req, _ := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/pets/42", nil)
pet, err := api.Do[*models.PetModel](req, http.StatusOK, true)
```

[Go 1.27](https://go.dev/doc/go1.27) allows methods to declare type parameters. Go service interfaces retain
concrete method signatures because interface methods cannot declare type parameters.

### Gin server

Install `@abhigyakrishna/tspgen-go-gin-server` and select it as the server target:

```yaml
emit:
  - "@abhigyakrishna/tspgen-go"
options:
  "@abhigyakrishna/tspgen-go":
    module: example.com/pets/models
    targets:
      - "@abhigyakrishna/tspgen-go-nethttp-client":
          module: example.com/pets/client
      - "@abhigyakrishna/tspgen-go-gin-server":
          module: example.com/pets/server
          max-body-size: 1048576
```

The server module pins Gin v1.12.0 and requires Go 1.25 or newer. Run `go mod tidy` in the generated server
module to resolve its dependencies. Implement the generated `Service` interface, then pass it to
`server.NewHandler(service)` to get a Gin engine with recovery middleware. Service methods accept
`context.Context` and typed request structs; the standard-library client interoperates with this server.

For an existing Gin engine, `server.RegisterRoutes(engine.Group("/api"), service)` mounts routes on a group
and uses its middleware. Set `engine.UseEscapedPath = true` before registering routes to match the generated
escaped patterns. The handlers decode path values once and preserve literal `+` and `%` characters. TypeSpec path
parameters must occupy a whole path segment; incompatible routes produce diagnostics.

Handlers decode scalar path/query/header parameters and JSON bodies, accept JSON media types including
`application/*+json`, and return 400 for malformed or trailing JSON, 415 for a non-JSON body, and 413 for a
body exceeding `max-body-size`. Optional empty bodies are accepted. Nonnullable bodies reject JSON `null`.
TypeSpec constraints, required properties, and nullability are checked by default; unknown model properties
are rejected unless `features.ignore-unknown-keys` is enabled.

Return `&server.HTTPError{StatusCode: 409, Body: body}` for an explicit JSON error response; wrapped errors
are supported. Other errors and response encoding failures return a sanitized 500. Service and response
encoding errors are also available through Gin's `Context.Errors` for application middleware. The Gin
target supports the same HTTP subset as the Go standard-library targets. Select one server target per
output directory, or give each target a separate `output-dir`.

## Options reference

Every on/off gate lives under `features:` (per language emitter and per target); every value choice is a flat
kebab-case key. Features marked with an `@meta` override can also be set per declaration, at one of three
levels — `declaration`: namespaces, interfaces, operations, models, enums, unions and scalars; `operation`: namespaces,
interfaces and operations; `model`: namespaces and models only (a namespace's value carries down to the models
it encloses; an enum, union, interface or operation may not override a `model`-level feature) — with
`@meta("<language>", #{ features: #{ <key>: false } })` (see Language-specific metadata). Plugins can declare
their own features (`TspGenPlugin.features`), set in the language emitter's `features:` block. These tables are
generated by `pnpm docs:options`.

<!-- options:start -->

### `@abhigyakrishna/tspgen-kotlin`

| Key | Kind | Default | `@meta` override | Description |
|---|---|---|---|---|
| `template-dir` | string | — | — | Directory with template overrides; takes precedence over plugin, target and language templates. |
| `plugins` | string[] | — | — | Plugin modules (relative paths or package names) applied in order. |
| `models-output-dir` | string | — | — | Output directory of the built-in models (default: emitter-output-dir). Relative to the project root; {project-root} and {emitter-output-dir} are interpolated. Targets take `output-dir` in their options. |
| `version` | string | — | — | Version of @versioned services to generate: a version enum member's name or value (default: the latest). |
| `header-text` | string | `Code generated by @abhigyakrishna/tspgen-kotlin. DO NOT EDIT.` | — | Banner at the top of every generated file, without comment syntax (each line becomes a line comment; multi-line allowed). Needs features.header. |
| `package` | string | `generated` | — | Base Kotlin package (default "generated"). |
| `naming` | object | — | — | Naming conventions for generated Kotlin identifiers. |
| `packages` | list | — | — | TypeSpec namespace → Kotlin package, e.g. [{ namespace: "Shop.Graph", package: "com.acme.graph" }]; longest prefix wins. |
| `errors` | `typed` \| `thrown` | `typed` | — | typed (default): …Exception per error body; thrown: error responses are documentation only. |
| `date-time` | `java.time` \| `kotlin.time` | `java.time` | — | java.time (default): Instant, OffsetDateTime, LocalDate, LocalTime, Duration from java.time with generated ISO-8601 serializers; kotlin.time: kotlin.time.Instant/Duration and kotlinx.datetime dates. |
| `decimal` | `big-decimal` \| `string` | `big-decimal` | — | decimal/decimal128 as java.math.BigDecimal (default; generated serializer writes a JSON string, reads a string or number) or String. |
| `scalar-style` | `inline` \| `typealias` \| `value-class` | `inline` | — | User scalars (scalar PetId extends string): inline (the base type), typealias PetId = String, or @JvmInline value class PetId(val value: String). Per scalar: @meta scalarStyle. |
| `union-variants` | `nested` \| `top-level` | `nested` | — | nested (default): variant models only a sealed union references are declared inside it, named after the variant key (NodeSource.Catalog); top-level: every variant is its own file. |
| `visibility` | `public` \| `internal` | `public` | — | Modifier on every generated top-level declaration, targets' included; public renders none. internal requires all generated code (models and every target's output) to compile in ONE Gradle module: it breaks layouts where models-output-dir / a target's output-dir point at different modules. |
| `file-annotations` | string[] | `[]` | — | Extra @file: annotations, e.g. Suppress("unused") or @file:Suppress("unused") (a leading "@file:" is stripped). Applies to every generated Kotlin file, targets included, after UseSerializers; must not repeat it. |
| `features.header` | feature | `true` | — | Banner comment at the top of every generated file (text: header-text). |
| `features.docs` | feature | `true` | declaration | KDoc/JSDoc from @doc and doc comments. |
| `features.api-version` | feature | `true` | — | Version constant (API_VERSION) for @versioned services; unversioned services never get one. |
| `features.generics` | feature | `true` | model | Template models once as generic types (Page<T>); false: one model per instance (PagePet). |
| `features.validation` | feature | `true` | — | Constraint decorators (@minLength, @maxLength, @pattern, @minItems, @maxItems, @minValue, @maxValue) as init { } checks throwing ModelCheckException (an IllegalArgumentException). |
| `features.enum-unknown` | feature | `false` | declaration | String enums get an UNKNOWN member that unknown wire values decode to (encoding it throws); for clients — servers should reject unknown input. |

### `@abhigyakrishna/tspgen-kotlin-ktor-server` (target)

| Key | Kind | Default | `@meta` override | Description |
|---|---|---|---|---|
| `routing-style` | string | `dsl` | — | dsl \| resources \| a style registered by a plugin |
| `grouping` | `per-interface` \| `per-namespace` \| `single-file` | `per-interface` | — | How operations are grouped into service interfaces and route files: per-interface (default, one per TypeSpec interface), per-namespace (one per enclosing namespace) or single-file (every operation in one). |
| `handler-shape` | `params` \| `request-object` | `params` | — | Shape of generated service methods' parameters: params (default, one Kotlin parameter per path/query/header/body field) or request-object (the operation's fields bundled into one generated <Op>Request data class parameter). |
| `service-suffix` | string | `Service` | — | Service interface suffix (e.g. "Api"). |
| `multipart` | `buffered` \| `streaming` \| `raw` | `buffered` | — | How multipart and file bodies reach the service: buffered (HttpFile / request class), streaming (Flow of parts / ByteReadChannel) or raw (MultiPartData / ByteReadChannel); per operation via @meta("kotlin:ktor-server", #{ multipart }). |
| `max-upload-size` | integer | `52428800` | — | Largest multipart part and buffered file body, in bytes (default 50 MiB, Ktor's formFieldLimit); larger ones answer 413. Per operation via @meta("kotlin:ktor-server", #{ maxUploadSize }). |
| `auth-providers` | object | `{}` | — | Auth scheme id → Kotlin expression naming its Ktor authentication provider (e.g. { BearerAuth: "JWT_AUTH" }); unmapped ids are used as string literals. |
| `sse` | `text-writer` \| `plugin` | `text-writer` | — | How server-sent event streams are written: text-writer (respondBytesWriter, no extra dependency) or plugin (the ktor-server-sse plugin, installed by the module); per operation via @meta("kotlin:ktor-server", #{ sse }). |
| `package` | string | — | — | Server package (default "<package>.server"). |
| `error-body` | `problem` \| `none` | `problem` | — | Default responder of <svc>Errors() for errors without a declared body (unmapped ApiException, 400, 413, 415): problem (RFC 9457 application/problem+json) or none (status only). |
| `sse-headers` | object | `{"Cache-Control":"no-store","X-Accel-Buffering":"no"}` | — | Headers set on every event-stream response (both sse modes); a configured map replaces the default, {} sets none. |
| `features.module` | feature | `true` | — | <Service>Module.kt: content negotiation, StatusPages and routing. |
| `features.auth` | feature | `true` | — | Wrap routes in authenticate(...) per the operations' @useAuth (off: only the authenticate/wrap meta keys). |
| `features.call-access` | feature | `false` | — | Pass the ApplicationCall to handlers. |
| `features.nest-routes` | feature | `false` | — | Nest each route function under its operations' common path prefix (dsl style). |
| `features.status-pages` | feature | `true` | — | The module installs StatusPages with <svc>Errors(); false: call <svc>Errors() inside your own install(StatusPages). |
| `features.ignore-unknown-keys` | feature | `false` | — | Accept request JSON with keys the models don't declare (false: 400). |
| `features.encode-defaults` | feature | `false` | — | Write optional properties equal to their default (unset ones as null) in responses and events; required ones are always written. |
| `features.errors` | feature | `true` | — | <Service>Errors.kt: StatusPagesConfig.<svc>Errors(). false: not emitted and the module installs no StatusPages; classify errors with serverErrorOf() in your own. |
| `features.explicit-nulls` | feature | `true` | — | serverJson writes null properties as null (kotlinx's explicitNulls); false: omits them (a required-but-nullable property included, which clients expecting the key, e.g. the generated TypeScript types, may not accept) and reads absent nullable ones as null. |

### `@abhigyakrishna/tspgen-kotlin-ktor-client` (target)

| Key | Kind | Default | `@meta` override | Description |
|---|---|---|---|---|
| `package` | string | — | — | Client package (default "<package>.client"). |
| `sse-max-size` | integer | `1048576` | — | Longest server-sent event line and event data the client accepts, in bytes (MAX_SSE_SIZE); longer ones fail the stream. |
| `features.ignore-unknown-keys` | feature | `true` | — | Ignore response fields the models don't declare (false: they fail decoding with SerializationException). |
| `features.encode-defaults` | feature | `false` | — | Write optional properties equal to their default in request bodies (kotlinx's encodeDefaults); required ones are always written. |
| `features.auth` | feature | `true` | — | Generate a <Service>Auth credential-provider parameter from @useAuth. |

### `@abhigyakrishna/tspgen-typescript`

| Key | Kind | Default | `@meta` override | Description |
|---|---|---|---|---|
| `template-dir` | string | — | — | Directory with template overrides; takes precedence over plugin, target and language templates. |
| `plugins` | string[] | — | — | Plugin modules (relative paths or package names) applied in order. |
| `models-output-dir` | string | — | — | Output directory of the built-in models (default: emitter-output-dir). Relative to the project root; {project-root} and {emitter-output-dir} are interpolated. Targets take `output-dir` in their options. |
| `version` | string | — | — | Version of @versioned services to generate: a version enum member's name or value (default: the latest). |
| `header-text` | string | `Code generated by @abhigyakrishna/tspgen-typescript. DO NOT EDIT.` | — | Banner at the top of every generated file, without comment syntax (each line becomes a line comment; multi-line allowed). Needs features.header. |
| `import-extension` | `none` \| `.js` | `none` | — | Suffix for relative imports: "none" for bundlers/Next.js (default), ".js" for Node ESM. |
| `layout` | `per-type` \| `single-file` | `per-type` | — | per-type (default): models/<Name>.ts + barrel; single-file: every model in types.ts. |
| `errors` | `typed` \| `thrown` | `typed` | — | typed (default): <Body>Error classes; thrown: error responses are documentation only. |
| `enum-style` | `union-const` \| `union` \| `enum` \| `const-array` | `union-const` | — | Enums and closed string-literal unions: "union-const" (default: literal union + const object), "union" (type only), "enum" (TypeScript enum; not erasable syntax), "const-array" (<Name>Values tuple + derived type). Per declaration: @meta enumStyle. |
| `declaration` | `interface` \| `type` | `interface` | — | Model declarations: "interface" (default) or "type" aliases (supertypes become intersections). |
| `date-type` | `string` \| `date` | `string` | — | utcDateTime as "string" (default, ISO-8601) or "date" (Date, decoded/encoded by a zod codec; needs features.zod). offsetDateTime, plainDate, plainTime and duration stay strings. |
| `features.header` | feature | `true` | — | Banner comment at the top of every generated file (text: header-text). |
| `features.docs` | feature | `true` | declaration | KDoc/JSDoc from @doc and doc comments. |
| `features.api-version` | feature | `true` | — | Version constant (API_VERSION) for @versioned services; unversioned services never get one. |
| `features.generics` | feature | `true` | model | Template models once as generic types (Page<T>); false: one model per instance (PagePet). |
| `features.zod` | feature | `false` | — | zod schemas (<Name>Schema) next to the types, constraint decorators as refinements; needs zod >= 4.3. |
| `features.barrel` | feature | `true` | — | models/index.ts re-exporting every model (per-type layout). |
| `features.readonly` | feature | `false` | declaration | Every model property readonly (a property's @meta readonly still wins); arrays stay T[]. |

### `@abhigyakrishna/tspgen-ts-nextjs-client` (target)

| Key | Kind | Default | `@meta` override | Description |
|---|---|---|---|---|
| `base-url-env` | string | `API_BASE_URL` | — | Environment variable holding the API base URL for Server Actions. |
| `client-style` | `grouped` \| `flat` | `grouped` | — | grouped: client/ with per-group classes, hooks, actions; flat: client.ts with one class. |
| `error-class` | string | — | — | Error class of the flat client (default "<Service>Error", after the first service when there are several). |
| `error-model` | string | — | — | Model (TypeScript name or TypeSpec id) whose fields the flat client's error class exposes. |
| `query-key-prefix` | string | — | — | React Query: prepended as the first element of every generated query key (e.g. "api" → ["api", "PetStore", …]). |
| `features.server-actions` | feature | `true` | — | Server Actions for non-GET operations (grouped style only). |
| `features.server-only` | feature | `true` | — | Grouped style: `import "server-only"` at the top of client/actions/server-client.ts, so importing it from a Client Component fails the Next.js build (needs server-actions). |
| `features.react-query` | feature | `true` | — | TanStack Query keys, queryOptions and hooks (flat style: queries.ts + hooks.ts); needs @tanstack/react-query. |
| `features.hooks` | feature | `true` | — | hooks.ts: React context, <Service>ClientProvider, use<Service>Client and the query/mutation hooks. false keeps only the server-safe queries.ts (needs react-query). |
| `features.validate` | feature | `true` | — | Flat style: check request bodies, query objects and constrained path parameters with zod before fetch; needs features.zod on the TypeScript emitter. |
| `features.error-getters` | feature | `true` | — | Flat style: isUnauthorized/isForbidden/isNotFound/isConflict getters on the error class. |

### `@abhigyakrishna/tspgen-go`

| Key | Kind | Default | `@meta` override | Description |
|---|---|---|---|---|
| `template-dir` | string | — | — | Directory with template overrides; takes precedence over plugin, target and language templates. |
| `plugins` | string[] | — | — | Plugin modules (relative paths or package names) applied in order. |
| `models-output-dir` | string | — | — | Output directory of the built-in models (default: emitter-output-dir). Relative to the project root; {project-root} and {emitter-output-dir} are interpolated. Targets take `output-dir` in their options. |
| `version` | string | — | — | Version of @versioned services to generate: a version enum member's name or value (default: the latest). |
| `header-text` | string | `Code generated by @abhigyakrishna/tspgen-go. DO NOT EDIT.` | — | Banner at the top of every generated file, without comment syntax (each line becomes a line comment; multi-line allowed). Needs features.header. |
| `go-version` | string | `1.22` | — | Minimum Go language/toolchain version written to go.mod (1.22 or newer). Targets inherit it, subject to their runtime minimum; generic client methods require 1.27 or newer. |
| `layout` | `single-file` \| `per-type` \| `per-namespace` | `single-file` | — | Models in one file, one file per type, or one file per TypeSpec namespace. All files belong to the configured models package. |
| `naming` | object | — | — | Go identifier conventions. Exported identifiers use PascalCase; configured initialisms retain their uppercase spelling. |
| `type-names` | object | `{}` | — | TypeSpec type id (e.g. Shop.Pet, or Shop.Maybe<int32> for a generic union instance), or unqualified type name, to exported Go name. Qualified entries take precedence. |
| `date-time` | `string` \| `time.Time` | `string` | — | Mapping of utcDateTime and offsetDateTime. time.Time uses Go's RFC 3339 JSON/text codecs; date, time and duration remain strings. |
| `decimal` | `json.Number` \| `string` \| `float64` | `json.Number` | — | decimal/decimal128: exact JSON numeric text, JSON strings, or floating point (which can lose precision). |
| `integer` | `json.Number` \| `int64` | `json.Number` | — | Unbounded integer scalar: exact JSON numeric text or signed 64-bit integers. Fixed-width scalars retain their declared width. |
| `scalar-style` | `inline` \| `alias` | `inline` | — | User scalar declarations inline their standard Go type or generate a named Go alias with the same wire codec. |
| `optional-fields` | `pointers` \| `values` | `pointers` | — | Optional model fields use pointers to preserve absence, or values with zero-value semantics. HTTP parameter request fields always preserve presence. |
| `module` | string | — | — | Import path of the generated models Go module. |
| `package` | string | `models` | — | Package name of generated models. |
| `features.header` | feature | `true` | — | Banner comment at the top of every generated file (text: header-text). |
| `features.docs` | feature | `true` | declaration | KDoc/JSDoc from @doc and doc comments. |
| `features.api-version` | feature | `true` | — | Version constant (API_VERSION) for @versioned services; unversioned services never get one. |
| `features.generics` | feature | `true` | model | Template models once as generic types (Page<T>); false: one model per instance (PagePet). |
| `features.validation` | feature | `true` | model | Generate Validate methods for constraints, literals and enum values, and validate required JSON properties when HTTP targets enable validate. |
| `features.validator` | feature | `false` | model | Generate go-playground/validator/v10 struct tags for supported constraints, literals, enums and nested collections. Independent of generated Validate methods; no runtime dependency is added. |
| `features.defaults` | feature | `true` | model | Apply declared property defaults when decoding missing JSON properties and generate model constructors that initialize them. |
| `features.omit-empty` | feature | `true` | — | Optional model properties carry json omitempty tags. Pointer fields preserve present zero values; value fields omit zero values. |
| `features.enum-unknown` | feature | `false` | declaration | String enums decode unknown wire values to an UNKNOWN sentinel accepted by validation (encoding it fails). Unions keep payloads matching no variant in an Unknown field, re-encoded unchanged and rejected by validation. |
| `features.go-mod` | feature | `true` | — | Generate the models go.mod. Client/server targets have their own go-mod feature. |

### `@abhigyakrishna/tspgen-go-nethttp-client` (target)

| Key | Kind | Default | `@meta` override | Description |
|---|---|---|---|---|
| `module` | string | — | — | Import path of this generated Go module; must differ from the models module. |
| `package` | string | `client` | — | Go package name (default client or server, depending on the target). |
| `go-version` | string | — | — | Target Go version; inherits the models version, with the target's runtime minimum applied. Explicit values must satisfy both minima. |
| `grouping` | `single-file` \| `per-interface` \| `per-namespace` | `single-file` | — | Organize operation declarations and implementations into one file, or files per TypeSpec interface/namespace. Files stay in one Go package. |
| `request-suffix` | string | `Request` | — | Suffix on generated operation request struct names. |
| `errors` | `raw` \| `typed` | `raw` | — | Raw HTTPError or additional typed errors for the operations' declared error response bodies. |
| `client-name` | string | `Client` | — | Name of the generated client struct and its constructor. |
| `max-response-size` | integer | `1048576` | — | Maximum response body size in bytes, for both successes and errors. Larger responses fail without silently truncating the body. |
| `timeout-ms` | integer | `0` | — | Timeout in milliseconds when no custom HTTPClient is supplied; 0 uses http.DefaultClient. |
| `features.go-mod` | feature | `true` | — | Generate this target's go.mod with its runtime dependencies and a local models replace directive. |
| `features.encode-defaults` | feature | `false` | — | Include optional properties equal to their declared default and unset optional properties as null in emitted JSON. |
| `features.explicit-nulls` | feature | `true` | — | Include nullable model properties whose value is null; false omits null struct properties (including required nullable ones). |
| `features.client-constructor` | feature | `true` | — | Generate NewClient (or New<client-name>) to construct a client with its configured defaults. |
| `features.generic-methods` | feature | `false` | — | Generate Client.Do[T any] and call it from typed endpoint methods. Requires an effective go-version of at least 1.27. |
| `features.validate` | feature | `false` | — | Validate request values before sending and response JSON after decoding (requires models features.validation). |
| `features.ignore-unknown-keys` | feature | `true` | — | Accept response JSON properties the models do not declare; false rejects them. |

### `@abhigyakrishna/tspgen-go-nethttp-server` (target)

| Key | Kind | Default | `@meta` override | Description |
|---|---|---|---|---|
| `module` | string | — | — | Import path of this generated Go module; must differ from the models module. |
| `package` | string | `server` | — | Go package name (default client or server, depending on the target). |
| `go-version` | string | — | — | Target Go version; inherits the models version, with the target's runtime minimum applied. Explicit values must satisfy both minima. |
| `grouping` | `single-file` \| `per-interface` \| `per-namespace` | `single-file` | — | Organize operation declarations and implementations into one file, or files per TypeSpec interface/namespace. Files stay in one Go package. |
| `request-suffix` | string | `Request` | — | Suffix on generated operation request struct names. |
| `errors` | `raw` \| `typed` | `raw` | — | Raw HTTPError or additional typed errors for the operations' declared error response bodies. |
| `service-name` | string | `Service` | — | Name of the service interface. Grouped output also generates embedded interfaces for each group. |
| `handler-shape` | `request-object` \| `params` | `request-object` | — | Service methods receive a typed request struct or individual path/query/header/body arguments. |
| `max-body-size` | integer | `1048576` | — | Maximum request body size in bytes; larger bodies receive HTTP 413. |
| `error-body` | `json` \| `problem` \| `none` | `json` | — | Fallback error response: JSON {error}, RFC 9457 application/problem+json, or an empty body. Explicit service error bodies are preserved. |
| `features.go-mod` | feature | `true` | — | Generate this target's go.mod with its runtime dependencies and a local models replace directive. |
| `features.encode-defaults` | feature | `false` | — | Include optional properties equal to their declared default and unset optional properties as null in emitted JSON. |
| `features.explicit-nulls` | feature | `true` | — | Include nullable model properties whose value is null; false omits null struct properties (including required nullable ones). |
| `features.handler` | feature | `true` | — | Generate NewHandler; RegisterRoutes is always available for application-owned routers and middleware. |
| `features.call-access` | feature | `false` | — | Pass the underlying *http.Request or *gin.Context to service methods, after context.Context. |
| `features.validate` | feature | `true` | — | Validate decoded request bodies and parameter constraints (requires models features.validation). |
| `features.ignore-unknown-keys` | feature | `false` | — | Accept request JSON properties the models do not declare; false rejects them. |

### `@abhigyakrishna/tspgen-go-gin-server` (target)

| Key | Kind | Default | `@meta` override | Description |
|---|---|---|---|---|
| `module` | string | — | — | Import path of this generated Go module; must differ from the models module. |
| `package` | string | `server` | — | Go package name (default client or server, depending on the target). |
| `go-version` | string | — | — | Target Go version; inherits the models version, with the target's runtime minimum applied. Explicit values must satisfy both minima. |
| `grouping` | `single-file` \| `per-interface` \| `per-namespace` | `single-file` | — | Organize operation declarations and implementations into one file, or files per TypeSpec interface/namespace. Files stay in one Go package. |
| `request-suffix` | string | `Request` | — | Suffix on generated operation request struct names. |
| `errors` | `raw` \| `typed` | `raw` | — | Raw HTTPError or additional typed errors for the operations' declared error response bodies. |
| `service-name` | string | `Service` | — | Name of the service interface. Grouped output also generates embedded interfaces for each group. |
| `handler-shape` | `request-object` \| `params` | `request-object` | — | Service methods receive a typed request struct or individual path/query/header/body arguments. |
| `max-body-size` | integer | `1048576` | — | Maximum request body size in bytes; larger bodies receive HTTP 413. |
| `error-body` | `json` \| `problem` \| `none` | `json` | — | Fallback error response: JSON {error}, RFC 9457 application/problem+json, or an empty body. Explicit service error bodies are preserved. |
| `features.go-mod` | feature | `true` | — | Generate this target's go.mod with its runtime dependencies and a local models replace directive. |
| `features.encode-defaults` | feature | `false` | — | Include optional properties equal to their declared default and unset optional properties as null in emitted JSON. |
| `features.explicit-nulls` | feature | `true` | — | Include nullable model properties whose value is null; false omits null struct properties (including required nullable ones). |
| `features.handler` | feature | `true` | — | Generate NewHandler; RegisterRoutes is always available for application-owned routers and middleware. |
| `features.call-access` | feature | `false` | — | Pass the underlying *http.Request or *gin.Context to service methods, after context.Context. |
| `features.validate` | feature | `true` | — | Validate decoded request bodies and parameter constraints (requires models features.validation). |
| `features.ignore-unknown-keys` | feature | `false` | — | Accept request JSON properties the models do not declare; false rejects them. |

<!-- options:end -->

## TypeScript / Next.js

```yaml
emit:
  - "@abhigyakrishna/tspgen-typescript"
options:
  "@abhigyakrishna/tspgen-typescript":
    import-extension: none            # none (Next.js/bundlers) | .js (Node ESM)
    layout: per-type                  # per-type (models/<Name>.ts + barrel) | single-file (types.ts, namespace banners)
    errors: typed                     # typed | thrown (no <Body>Error classes; success unions unchanged; api/errors.ts keeps HttpError)
    features:
      zod: true                       # PetSchema: z.ZodType<Pet> next to each type, constraint decorators as refinements (default false; zod ≥ 4.3)
    targets:
      - "@abhigyakrishna/tspgen-ts-nextjs-client":
          client-style: grouped       # grouped (client/…, hooks, actions) | flat (client.ts: one <Service>Client class)
          base-url-env: API_BASE_URL  # env var read by the actions' server-side client
          error-class: PetStoreError  # flat: error class name (default <Service>Error)
          error-model: ErrorResponse  # flat: model whose fields the error class exposes (optional)
          query-key-prefix: api       # React Query: first element of every generated query key (default: none)
          features:
            react-query: true         # TanStack Query keys, queryOptions and hooks (both styles, default true)
            server-actions: true      # grouped only (flat: ignored; unsupported-feature when set true)
            validate: true            # flat only: zod checks of body/query/constrained path params before fetch (needs features.zod)
            server-only: true         # grouped: import "server-only" in the Server Actions' server client
            hooks: true               # false: queries.ts only (no React context/provider/hooks)
            error-getters: true       # flat: isUnauthorized/isForbidden/isNotFound/isConflict on the error class
```

Output: `models/` (one file per type + `index.ts`), `api/` (`HttpError` + typed `<Body>Error` classes,
multi-status result unions), and `client/`. With `layout: single-file`, models go to a single `types.ts`
instead of `models/`.

```
client/core.ts                   ClientConfig, RequestOptions, request/parse/toError runtime
client/<group>.ts                <Group>Client + <Group><Op>Params (and zod params schemas)
client/index.ts                  <Service>ApiClient, create<Service>Client, re-exports
client/react-query/queries.ts    <service>Keys, <service>Queries (server-safe, for prefetch)
client/react-query/hooks.ts      "use client": <Service>ClientProvider, use<Group><Op>Query/Mutation
client/actions/<group>.ts        "use server": <group><Op>Action → ActionResult<T>
client/actions/server-client.ts  configure<Service>Actions(), server-side client factory
```

```ts
// Server Component / Route Handler — Next.js caching options pass straight through to fetch
const api = createPetStoreClient({ baseUrl: process.env.API_BASE_URL!, auth: { BearerAuth: () => token() } });   // with @useAuth (see Authentication); else headers: async () => ({ authorization: … })
const pets = await api.pets.list({ limit: 10 }, { next: { revalidate: 60, tags: ["pets"] } });

// Client Component
<PetStoreClientProvider client={createPetStoreClient({ baseUrl: "/api" })}>…</PetStoreClientProvider>
const { data } = usePetsGetQuery({ petId: 1 });
const create = usePetsCreateMutation({ onSuccess: () => queryClient.invalidateQueries({ queryKey: petStoreKeys.pets.all }) });

// Prefetch on the server, hydrate on the client
await queryClient.prefetchQuery(petStoreQueries.pets.get(api, { petId: 1 }));

// Server Action from a form or Client Component — errors come back as data, not exceptions
const result = await petsCreateAction({ pet });
if (!result.ok) console.error(result.status, result.error);
```

**Request options.** Every method takes a trailing `RequestOptions`: every `RequestInit` field except `method`,
`body` and `window` (`credentials`, `mode`, `keepalive`, `redirect`, `priority`, `referrerPolicy`, `integrity`,
`cache`, `signal`, …), `headers`, and Next.js `next` (`{ revalidate?, tags? }`). `init` in `ClientConfig` (flat:
`ClientOptions`) sets fetch options for every request. Precedence, lowest first: `init`, `@meta(…,
"typescript:ts-nextjs-client", #{ next })` defaults, the call's options; `next` is replaced, not merged. Headers
merge separately: the config's `headers` (static, or a sync or async function called per request), then
`@useAuth` credentials, then the call's `headers`. In the grouped client, an operation's own `@header` parameters
are applied last — after the call's `headers` — so they win on a name clash, and its `@cookie` parameters (plus
any `@useAuth` cookie credentials) are appended as a single `cookie` header, also after the call's `headers`; the
flat client has no header or cookie parameters. The client then sets `content-type` (and, for event streams,
`accept` unless a header already did).

```ts
const api = createPetStoreClient({ baseUrl: "/api", init: { credentials: "include" } });   // cookies on every call
await api.pets.list({ limit: 10 }, { cache: "no-store", keepalive: true });
```

**Middleware.** There are no generated interceptor hooks: pass a wrapping `fetch`, which sees every request and
response of both client styles.

```ts
const logging: typeof fetch = async (input, init) => {
  const started = Date.now();
  const res = await fetch(input, init);
  console.log(init?.method, String(input), res.status, `${Date.now() - started}ms`);
  return res;
};
const withTimeout = (ms: number, inner: typeof fetch = fetch): typeof fetch => (input, init) =>
  inner(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms) });
const withRetry = (attempts: number, inner: typeof fetch = fetch): typeof fetch => async (input, init) => {
  for (let i = 1; ; i++) {
    const res = await inner(input, init);
    if (res.status < 500 || i >= attempts || (init?.method ?? "GET") !== "GET") return res;   // retry GETs only
    await res.body?.cancel();   // release the discarded response's connection before retrying
  }
};
const api = createPetStoreClient({ baseUrl: "/api", fetch: withRetry(3, withTimeout(5_000, logging)) });
```

A wrapping `fetch` sees every call the same way, including `async *watch(…)` SSE stream methods: `withTimeout` above
races the *whole* request (and, for a stream, everything it will ever yield) against its timer, so a long-lived
stream gets aborted once `ms` elapses. Give stream methods a much longer or no timeout — e.g. skip `withTimeout`
when `new Headers(init?.headers).get("accept") === "text/event-stream"` — or compose it only around the
non-streaming client calls.

**`server-only`.** `client/actions/server-client.ts` (it reads `process.env.<base-url-env>`) starts with
`import "server-only";` (`features.server-only`, default true), so importing it from a Client Component fails the
Next.js build instead of throwing at call time. The `"use server"` action files don't import it — Client
Components import those on purpose. Next.js resolves `server-only` and declares its types; outside Next.js,
alias it to an empty module wherever Server Actions run (vitest:
`resolve: { alias: { "server-only": fileURLToPath(new URL("./test/server-only-stub.ts", import.meta.url)) } }` with
the stub `export {};`; jest: `moduleNameMapper`), and give a `tsc` without Next's types
`declare module "server-only";` or `"types": ["next"]`.

**Hooks and query keys.** `features.hooks: false` drops `hooks.ts` (context, provider, `use<Service>Client`,
query and mutation hooks) in both styles and keeps the server-safe `queries.ts`, for apps that provide the client
themselves: `useQuery(petStoreQueries.pets.get(api, { petId: 1 }))`. `query-key-prefix: api` makes `"api"` the
first element of every generated key (`["api", "PetStore", "pets", "get", params]`, `all` keys included), so
`invalidateQueries({ queryKey: ["api"] })` covers every generated query and two generated clients sharing a
`QueryClient` don't collide.

The fetch client throws `HttpError` subclasses (`NotFoundError` has a typed `.error`). An
`application/problem+json` response (the Ktor server's own 4xx/5xx) is never decoded as a declared error model: it
throws a plain `HttpError` whose `body` is the problem and whose message is its `detail` (else `title`). With zod on,
responses are validated (`validate: false` in `ClientConfig` turns it off) and Server Action input is
checked first (`{ ok: false, status: 400, error: { issues } }`; not affected by `validate: false`). Direct
`<Group>Client` calls don't check their params. Property names match the JSON wire names; dates are ISO
strings (`Date`s decoded by zod codecs with `date-type: date`).

**Constraints in zod.** With `features.zod`, TypeSpec constraint decorators on model properties and operation
parameters become refinements on the generated schemas: `@minLength`/`@maxLength` → `.min(n)`/`.max(n)` on
strings, `@pattern` → `.regex(new RegExp("…", "u"))`, `@minItems`/`@maxItems` → `.min`/`.max` on arrays,
`@minValue`/`@maxValue` → `.gte`/`.lte` on numbers, and `notBlank: true` in meta scope `*` or `typescript` →
`.regex(/\S/, "must not be blank")`. Constraints that don't fit the property's type are ignored, and a
property with a `@TS.type` override gets none. Optional properties use zod's `.exactOptional()` instead of
`.optional()`, so schemas type-check under `exactOptionalPropertyTypes`; when parsing responses or models,
an optional key present with value `undefined` (e.g. `{ note: undefined }`) fails — omit the key instead.
Request checks (Server Action input, flat `features.validate` bodies) drop `undefined`-valued keys first, as JSON
does when sending. Not applied: numeric bounds (`@minValue`/`@maxValue`) on `decimal`/`decimal128` (zod
strings, so string constraints such as `@pattern` do apply), `@minValueExclusive`/`@maxValueExclusive`, and
scalar-level constraints on array items (`Slug[]`); `notBlank` applies to model properties only. `@pattern`
is compiled with the `u` flag when valid there (else without flags), and a pattern JavaScript can't parse is
skipped with an `invalid-pattern` warning.

**Flat client** (`client-style: flat`) — one class per service, for projects that want a thin typed `fetch`
wrapper instead of the grouped client/hooks/actions tree:

```
types.ts / models/…   models (per layout)
client.ts             ClientOptions, <error-class> (default <Service>Error), <Service>Client (one method per operation)
index.ts              export * from ./types (or ./models/index), ./client (and ./queries unless features.react-query is false)
queries.ts            features.react-query only — <Op>Vars, <service>Keys, <service>Queries (server-safe)
hooks.ts              features.react-query only — "use client": <Service>ClientProvider, use<Service>Client,
                      use<Op>Query / use<Op>Mutation (not re-exported from index.ts; import from ./hooks)
```

```ts
const api = new ShopClient({ baseUrl: "/api", headers: async () => ({ authorization: await token() }) });   // or a plain object
const page = await api.listNodes({ kind: "DATABASE", limit: 10 });   // path params, then body, then a query object
try { await api.readNode(id); } catch (e) { if (e instanceof ShopError && e.isNotFound) … }
await api.readNode(id, { signal: controller.signal, cache: "no-store" });   // optional trailing RequestOptions
```

Methods are named after operations (names must be unique across the service) and take path parameters
positionally, then the body, then a query object (named `query`, or `queryParams`/`params` if that name is
already taken), then an optional `init?: RequestOptions` passed to `fetch` (see Request options; `@meta` `next`
defaults apply as in the grouped client), named `init`, or `requestInit`/`options`/`init2`… if a parameter
already uses the name; array query values are comma-joined into one value unless the param has `explode: true`, in
which case the key repeats. A path parameter or body named like a reserved word (`class`, `default`, …) is
renamed inside the method (`classValue`); parameters are positional, so callers are unaffected. Void operations don't read the response body; others decode an empty body as
`undefined`. `<error-class>` exposes `status`, `body` (the `error-model`, decoded only when the JSON error body
has all of that model's required fields, else `undefined`; without `error-model` it's the raw decoded body),
the model's other identifier-named fields (nullable types kept as-is), `problem` (an `application/problem+json`
body, which is never the `error-model`: `body` stays `undefined` and the message is the problem's `detail`, else
`title`), and
`isUnauthorized`/`isForbidden`/`isNotFound`/`isConflict` (`features.error-getters: false` leaves the getters out; the grouped style has typed error classes instead).

The flat client does not validate responses. With `features.validate` (on by default; effective only with `features.zod` on the
`@abhigyakrishna/tspgen-typescript` options), each method checks its body (skipped when an optional body is
`undefined`; `undefined`-valued keys are ignored), its query object, and any path parameters that carry
constraints against the generated zod schemas before calling `fetch`; on failure the returned promise
rejects with zod's `ZodError` — not `<error-class>` — and the original value is still sent, not zod's
parsed copy. A path parameter or body named `z` is renamed inside the method so it does not shadow the zod
import (parameters are positional, so callers are unaffected), and a generated type named `z` is reported as
a name clash. The grouped client style validates responses and Server Action input (not direct
`<Group>Client` calls) on its own; setting `features.validate: true` there has no effect and warns (`unsupported-feature`).
The flat client also ignores `errors: typed` for its own error handling: `<error-class>` is always the flat client's single thrown error type, so the
`api/` `<Body>Error` classes are still generated but go unused; set `errors: thrown` to skip generating them.

**Flat client + TanStack Query** (`features.react-query`, on by default):

```ts
// queries.ts (server-safe, re-exported from index.ts) — prefetch on the server
await queryClient.prefetchQuery(shopQueries.nodes.readNode(api, { id }));

// app/providers.tsx — a class instance can't cross from a Server Component, so create the client here, once
"use client";
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  // with @useAuth, credentials are configured here too: { baseUrl: "/api", auth: { BearerAuth: () => getToken() } }
  const [api] = useState(() => new ShopClient({ baseUrl: "/api" }));
  return (
    <QueryClientProvider client={queryClient}>
      <ShopClientProvider client={api}>{children}</ShopClientProvider>
    </QueryClientProvider>
  );
}

// Client Components (hooks from ./hooks, "use client") — every hook takes one <Op>Vars object
const { data } = useReadNodeQuery({ id });
const nodes = useListNodesQuery({ query: { kind: "DATABASE" } }, { staleTime: 5_000 });
const update = useUpdateNodeMutation({ onSuccess: () => queryClient.invalidateQueries({ queryKey: shopKeys.nodes.all }) });
update.mutate({ id, body: { name: "db" }, query: { dryRun: true } });
```

`<Op>Vars` (for operations with inputs) holds the path parameters under the generated parameter names
(camelCased, e.g. `@path node_id` → `nodeId`; a parameter renamed inside the method — `z` with `features.validate`, a
reserved word such as `class` — keeps that name here), `body` (optional when the body is; documented with the
body parameter's doc comment), and `query` (the method's query object; optional unless a query parameter is
required); operations without inputs get no Vars type and their hooks take none (`useRefreshMutation()`,
variables `void`). A void GET/HEAD query resolves `null` (TanStack Query rejects `undefined` data), so its data
type is `null`; the grouped client's void queries do the same. Keys and query options of deprecated
operations are marked `@deprecated`, like their hooks. Keys are
`<service>Keys.all` (`[Service]`), `<service>Keys.<group>.all` (`[Service, group]`) and, per GET/HEAD
operation, `<service>Keys.<group>.<op>(vars)` (`[Service, group, op, vars]`); `<service>Queries.<group>.<op>(client,
vars)` returns `queryOptions` whose `queryFn` passes TanStack's `signal` to the method (cancelled queries abort
the fetch) and applies `staleTime` from `@meta(…, "typescript:ts-nextjs-client", #{ staleTime })`. GET/HEAD
operations get `use<Op>Query(vars, options?)`; all others, uploads included, get `use<Op>Mutation(options?)`
whose `mutate` takes the Vars object (mutations are not cancellable). `use<Service>Client()` throws outside
`<Service>ClientProvider`. With `features.hooks: false` only `queries.ts` is generated, and the provider, context
and hook names are free for generated types. Hooks and query options call the provided client's methods, so `@useAuth` credentials
(the client's `auth` option) and the query's `signal` both reach `fetch`. An operation with a path parameter named `body` (and a body) or `query` (and query
parameters), which would collide with those Vars keys, gets no hooks, keys or Vars — only its client method —
with a `flat-react-query-skipped` warning. With `features.react-query` the flat style also reports a hook, Vars type or query key generated twice — the same operation name in two services, a query operation
named `all`, a group named `All` (`flat-react-query-name-clash`); and generated types named like the new
exports or like the TanStack Query / React names the two files use (`queryOptions`, `useQuery`,
`useMutation`, `UseQueryOptions`, `UseMutationOptions`, `createContext`, `createElement`, `useContext`,
`ReactNode`, `Omit`, `ReturnType`, `<Service>ClientContext`) (`flat-client-name-clash`).

React Query hooks and Server Actions are on by default (`features.react-query`, `features.server-actions`);
Server Actions exist only in the grouped style: under `client-style: flat`, `features.server-actions: true` is
ignored with an `unsupported-feature` warning. The flat style also
rejects, per operation, several success responses or response headers, header/cookie parameters, non-JSON
bodies other than multipart and file uploads, non-JSON responses, optional path parameters, and operation
names that clash with client members (`flat-client-unsupported`); rejects duplicate operation names
(`duplicate-operation-name`); rejects an `error-model` that isn't a generated model (`unknown-error-model`);
and rejects a generated type named like the error class, `ClientOptions`, `RequestOptions`, `RequestDefaults`,
`NextFetchOptions`, `HeadersInput`, `<Service>Client` or, with `@useAuth`,
`<Service>Auth` (`flat-client-name-clash`, since `index.ts` re-exports both), or like a name `client.ts` uses
internally — a global such as `Response`, `Promise`, `RequestInit`, `Omit` or `AbortSignal`, with uploads `BodyInit`,
`RawBody`, `PartSpec` or `toFormData`, with `@useAuth` `AuthScheme`, `AuthEntries`, `resolveAuth` or `base64`, with
server-sent event streams `EventSpec`, `RawEvent`, `readEvents`, `decodeEvents`, `decodeData`, `MAX_SSE_SIZE`,
`AsyncGenerator`, `AsyncIterable`, `ReadableStream`, `TextDecoder` or `Uint8Array`, with `features.validate` zod's `z` (same
code, its own message) — rename it with `@TS.name`. With `@useAuth`, an operation named `auth` clashes with a client
member. `Headers`, `Blob`, `File` and `FormData` are read through `globalThis`, so models may use those names.
Server-sent event streams are the one non-JSON response the flat style accepts (see Server-sent events).

## Uploads (multipart and file bodies)

```tsp
model PhotoUpload {
  caption: HttpPart<string>;
  rating?: HttpPart<int32>;
  pet: HttpPart<Pet>;             // JSON part
  photo: HttpPart<File>;
  extras?: HttpPart<File>[];      // repeated part
}

@route("/uploads") interface Uploads {
  @post upload(@header contentType: "multipart/form-data", @multipartBody body: PhotoUpload): UploadReceipt;
  @put @route("/avatar") avatar(@bodyRoot file: File<"image/png">): void;
}
```

A part is `text` (scalars, enums and literals, also nullable — encoded like a query parameter, even when TypeSpec
gives it an `application/json` content type), `json` (models, arrays, records, tuples and unions with such a
variant, e.g. `HttpPart<Cat | Dog>` or `HttpPart<Meta | null>` — sent as `application/json`) or `file`
(`Http.File`, a model extending it, or `bytes`: `HttpPart<bytes>` is a file part too). A part declared with an
envelope, `HttpPart<{ @header contentType: "application/vnd.x+json"; @body value: Meta }>`, is a `Meta` part with
that content type (no wrapper model). The `contentType` header parameter of a multipart or file operation is
dropped from every generated signature (the HTTP runtime sets it, with the multipart boundary), and a plain
`Http.File`'s `*/*` content type counts as none declared.

| Target | Multipart body | File body |
|---|---|---|
| Kotlin models | `PhotoUpload` (and any model declaring `HttpPart`s) is a plain (non-`@Serializable`) data class; file parts are `HttpFile(filename, contentType, bytes)` / `List<HttpFile>`; `HttpFile.kt` is generated only when a file is used | `HttpFile` |
| Ktor server `buffered` (default) | `upload(body: PhotoUpload)`; the declared parts read into memory (others skipped unread); a missing required part → 400 | `avatar(file: HttpFile)` (filename from `Content-Disposition`, else `null`) |
| Ktor server `streaming` | `upload(parts: Flow<PhotoUploadPart>)` with `PhotoUploadPart.Caption(value)`, …, `PhotoUploadPart.Photo(filename, contentType, channel)`; one `PhotoUploadPart.kt` per model in the server package (a model with the same simple name from another package gets a package-prefixed name) | `avatar(contentType: String?, channel: ByteReadChannel)` |
| Ktor server `raw` | `upload(data: MultiPartData)` | `avatar(channel: ByteReadChannel)` |
| Ktor client | `upload(body: PhotoUpload)` → `MultiPartFormDataContent`, same `PhotoUpload`/`HttpFile` shape as the buffered server | `avatar(file: HttpFile)` → the bytes with `file.contentType`, else the declared type |
| TypeScript models | file parts are `globalThis.Blob` (a DOM `File` is one; `globalThis` so a model named `Blob` cannot shadow it), zod `z.instanceof(globalThis.Blob)` | `globalThis.Blob` |
| Next.js grouped / flat client | the body object is sent as `FormData`; fetch sets the content type (with the boundary), not the client, replacing any `Content-Type` from the client headers | the `Blob` is sent as-is with `blob.type`, else the declared type |

Pick the server mode with the `multipart` target option, or per operation / interface / namespace with
`@@meta(PetStore.Uploads.upload, "kotlin:ktor-server", #{ multipart: "streaming" })` (other values warn
`invalid-meta` and fall back to the option).

- Size limit (`max-upload-size`, default 50 MiB, Ktor's default `formFieldLimit`; override it per operation /
  interface / namespace with `#{ maxUploadSize: 1048576 }` in the same `@meta("kotlin:ktor-server", …)`):
  - every multipart part, in all modes (via `receiveMultipart(formFieldLimit)`), may hold at most that many bytes;
  - `buffered` multipart additionally caps the total it buffers for one request (the declared parts together) at
    that many bytes, and a `buffered` file body too;
  - `streaming` and `raw` multipart hand the parts to the service as they arrive, without a total cap, and
    `streaming`/`raw` file bodies hand the service the request channel unbounded.

  Over a limit → **413 Payload Too Large**. Only Ktor's multipart parser failing on the limit becomes 413: an
  exception the service (or a `streaming` collector) throws itself propagates unchanged, whatever its message.
  With `error-body: problem` (default) the 413 carries a problem body.
- `buffered` holds the declared parts in memory; use `streaming` or `raw` for large files. It also answers 400
  when a part that is not a list (`HttpPart<T>`, not `HttpPart<T>[]`) is sent more than once
  (`Part 'photo' must be sent at most once`).
- A streaming `Flow` can be collected once (a second collection throws `IllegalStateException`); a file part's
  `channel` is readable only until the collector returns for that part; unlike `buffered`, required parts are
  not checked. Undeclared parts are skipped.
- The Ktor server needs file parts sent **with a filename** (`Content-Disposition: form-data; name="photo";
  filename="…"`): Ktor reads a part without one as UTF-8 text, which would corrupt binary content, so
  `buffered` and `streaming` answer 400 (`File part 'photo' must be sent with a filename`). The generated
  clients always send one.
- JSON parts are read and written with the models' JSON configuration (the java.time serializers included).
- A file part is always sent with a filename (the part name when the file value has none) and a content type
  (its own, else the part's declared type, else `application/octet-stream`). JSON parts are sent with the part's
  declared JSON content type (`application/json` unless it declares another), which the Ktor server reads like
  text parts.
- In the Next.js clients, a JSON part is a `Blob` in the `FormData` typed with the part's declared JSON content
  type (`application/json` unless it declares another, e.g. `application/vnd.meta+json`), so fetch sends it with
  `filename="blob"`: fine for Ktor, but frameworks that treat every part with a filename as a file upload (multer,
  FastAPI, …) see it as a file. A `multipart/mixed` operation is sent as `multipart/form-data` (all `FormData`
  can encode).
- Not supported: file or multipart **responses** (downloads), tuple-form `@multipartBody` (error
  `unsupported-multipart-tuple`; the operation is skipped), React Query hooks and Server Actions for upload
  operations (skipped — call the client directly), and `Http.File` used inside a JSON model.
- Diagnostics: a multipart body model that `extends` a model with parts is an error
  (`unsupported-multipart-base` — TypeSpec ignores inherited parts; spread the base with `...Base` instead) and
  its operation is skipped; `Http.File` inside a JSON model or as a response body warns `file-in-json`; a model
  with parts also used as JSON (a response, a JSON body, a JSON model's property) warns
  `multipart-model-in-json`. In Kotlin, a model of your own named `HttpFile` in the models package clashes with
  the file class (`http-file-conflict`; rename it with `@Kotlin.name`).

## Authentication (`@useAuth`)

```tsp
@service @useAuth(BearerAuth) namespace PetStore;
model PartnerKey is ApiKeyAuth<ApiKeyLocation.header, "X-Partner">;

@route("/pets") interface Pets {
  @get list(): Pet[];                                          // BearerAuth (service level)
  @get @route("/public") @useAuth(NoAuth) featured(): Pet[];   // public
  @get @route("/mine") @useAuth(BearerAuth | NoAuth) mine(): Pet[];   // optional
  @delete @useAuth(BearerAuth | PartnerKey) remove(@path petId: int64): void;
  @post @useAuth([BearerAuth, PartnerKey]) import(@body pets: Pet[]): void;   // both
}
```

`@useAuth` on the service namespace, an enclosing namespace, an interface or an operation applies; the nearest
one wins (`NoAuth` included). Scheme ids are the scheme models' names (`BearerAuth`, `PartnerKey`); a different
scheme reusing an id (two inline `ApiKeyAuth<…>` instances) gets `_` appended, as in TypeSpec's OpenAPI output.
APIs without `@useAuth` generate exactly what they did before.

**Ktor server.** Each route is wrapped in `authenticate(...)` naming one provider per scheme — the scheme id as a
string (`authenticate("BearerAuth")`), or the Kotlin expression mapped in `auth-providers`
(`{ BearerAuth: JWT_AUTH }` → `authenticate(JWT_AUTH)`; the expression must resolve in the routes file: use a
fully qualified name or add its import with the `imports` meta key; a blank one is an error, and a key naming no
scheme id warns `unknown-auth-provider` — mind the `_` of renamed ids). Install Ktor `Authentication` with
providers of those names. Routes with the same wrapper share one block.

| `@useAuth` | Generated wrapper |
|---|---|
| `A` / `A \| B` | `authenticate(pA)` / `authenticate(pA, pB)` (the first valid credential wins; the others aren't checked) |
| `[A, B]` (A & B) | `authenticate(pA, pB, strategy = AuthenticationStrategy.Required)` |
| any of these `\| NoAuth` | `authenticate(…every scheme…, optional = true)`: anonymous calls pass; with credentials, the first valid one wins (the others aren't checked) and only all-invalid credentials get 401 |
| `[A, B] \| NoAuth` (a combination and `NoAuth`) | the same `authenticate(pA, pB, optional = true)`, so one valid credential is enough: warning `auth-combination-approximated` |
| `NoAuth` only, or none | none |
| `[A, B] \| C` (several alternatives, one needing several schemes) | error `unsupported-auth-combination`; fails closed with `authenticate(pA, pB, pC, strategy = AuthenticationStrategy.Required)` (every scheme required) until you set the `authenticate` meta key |

Nested `authenticate` blocks are not used for `A & B`: Ktor collects the providers of nested blocks into one
set, each with its block's strategy, so two default (first-successful) blocks accept either credential. For the
same reason, don't combine `@useAuth` with a `wrap` that calls `authenticate(...)` (the house-style pattern):
the route would accept either provider — use the `authenticate` meta key or `features.auth: false` instead. The `authenticate` meta key on an operation
or group replaces the generated wrapper (and silences `unsupported-auth-combination` and
`auth-combination-approximated`); `wrap` wrappers go inside it. An `authenticate` key inherited from a namespace or
group replaces the wrapper of an operation with its own `@useAuth` too, so it can loosen (or tighten) that
operation's auth. `features.auth: false` turns generation off. The Ktor client generates credentials from
`@useAuth`, see below.

**Next.js clients.** A service using schemes the client can send gets a `<Service>Auth` type of credential
providers, keyed by scheme id (quoted when not an identifier), passed as `auth` in the grouped client's
`ClientConfig` (`createPetStoreClient({ baseUrl, auth })`, `configurePetStoreActions({ auth })`) or the flat
client's `ClientOptions` (`new PetStoreClient({ baseUrl, auth })`):

```ts
const api = createPetStoreClient({
  baseUrl: process.env.API_BASE_URL!,
  auth: {
    BearerAuth: async () => (await cookies()).get("token")?.value,   // string | undefined, sync or async
    PartnerKey: () => process.env.PARTNER_KEY,
    // BasicAuth: () => ({ username, password }),
  },
});
```

| Scheme | Provider returns | Sent as |
|---|---|---|
| http `Bearer`, `OAuth2Auth`, `OpenIdConnectAuth` (tokens only, no flows) | `string` | `Authorization: Bearer <token>` |
| http `Basic` | `{ username, password }` | `Authorization: Basic <base64 of UTF-8 username:password>` |
| `ApiKeyAuth` | `string` | the named header, query parameter (replacing a same-named one) or cookie (joined with the operation's cookie parameters and a configured `cookie` header; **server-side only**, see below) |

A provider returning `undefined`, `null` or `""` supplies no credential.

**Cookie API keys only work server-side.** `Cookie` is a forbidden request header: browsers silently drop it from
`fetch`, so an `ApiKeyAuth` in a cookie is only sent from server code (Server Components, Route Handlers, Server
Actions, plain Node). In the browser, rely on the browser's own cookies instead: same-origin requests carry them,
cross-origin ones need a custom `fetch` with `credentials: "include"` (and a CORS setup allowing credentials):

```ts
const api = createPetStoreClient({ baseUrl: "/api", fetch: (input, init) => fetch(input, { ...init, credentials: "include" }) });
```

Each operation carries its alternatives (`auth: [[{ id: "BearerAuth", kind: "bearer" }], …]` in the request
spec); per request the client sends the first alternative whose providers all return a value (each provider is
called at most once per request). When none does, or the operation is `NoAuth` only, no credentials are added
and the server decides (an optional operation, `A | NoAuth`, still sends `A` when available). Credentials override
the configured `headers` (so they win over a configured `Authorization`); per-call `RequestOptions.headers` (both
clients) and header parameters (grouped client) override credentials in turn — unlike the Ktor client, where a
credential wins over a header parameter of the same name. Uploads, React Query hooks and
Server Actions go through the same client. Other http schemes (e.g. `Digest`) warn `unsupported-auth-scheme`;
alternatives needing them are dropped. An alternative sending two credentials as the same header (compared
case-insensitively: `[BearerAuth, BasicAuth]`, or a bearer token with an API key header named `Authorization`)
warns `auth-header-conflict`, naming the operation and header; only the last credential is sent. An API key sent
in the query under the name of one of the operation's query parameters replaces that parameter's value and warns
`auth-header-conflict` too. The warning is core's (`@abhigyakrishna/tspgen-core/auth-header-conflict`, the same for
both clients) and targets the operation, so `#suppress` on it silences it.

`ClientConfig` and `ClientOptions` default to an untyped `auth` (`object`): a service without schemes the client
can send, and group classes constructed directly (`new PetsClient(config)`), accept any `auth`, which then has no
effect. React Query keys don't include the caller's identity, so clear the `QueryClient` (`queryClient.clear()`)
on login and logout to avoid serving one user's cached data to the next. Path parameters are escaped with
`encodeURIComponent`, which leaves `.` and `..` as they are; URL parsing then resolves such a segment as a dot
segment (`/pets/..` → `/`), so validate path values that may be `.` or `..` (this applies with or without auth).

**Ktor client.** A service using schemes the client can send gets a `<Service>Auth` class with one provider per
scheme, named after the camel-cased scheme id, passed to the API client (`features.auth: false` turns this off):

```kotlin
val api = PetStoreApiClient(http, baseUrl, PetStoreAuth(
    bearerAuth = { session.token },                            // suspend () -> String?
    partnerKey = { System.getenv("PARTNER_KEY") },
    // basicAuth = { BasicCredentials(user, password) },
))
```

Per request (per collection for event streams) the client sends the first alternative whose providers all return a
value (`null` and `""` are none; each provider is called at most once); `NoAuth`, or no satisfied alternative, sends
nothing and the server decides. Bearer/OAuth2/OpenID Connect tokens go in `Authorization: Bearer`, Basic in
`Authorization: Basic` (UTF-8, base64), API keys in their header, query parameter (replacing a same-named one) or
cookie. A credential replaces a header or query parameter of the same name (warning `auth-header-conflict`): in
the Ktor client credentials take precedence over an explicit header parameter, whereas the TypeScript clients let
per-call headers override credentials. Other http schemes warn `unsupported-auth-scheme`. Ktor's `Auth` plugin or
`defaultRequest` still work: pass no `auth`. Combined with generated credentials, the `Auth` plugin's bearer or
basic provider sets `Authorization` itself, replacing the generated one, while a `defaultRequest` header is added
next to it, so both `Authorization` values are sent.

## Versioning

Specs using [`@typespec/versioning`](https://typespec.io/docs/libraries/versioning/reference/) generate code for
**one version** per emit. Install the library next to the compiler (it is an optional peer dependency of
`@abhigyakrishna/tspgen-core`, loaded only when a spec imports it):

```bash
npm install -D @typespec/versioning
```

```tsp
@service @versioned(Versions) namespace PetStore;
enum Versions { v1: "2024-01-01", v2: "2024-06-01" }

model Pet {
  id: int64;
  @renamedFrom(Versions.v2, "title") name: string;
  @added(Versions.v2) age?: int32;
  @madeOptional(Versions.v2) tag?: string;
}
```

- The `version` option (both emitters) picks the version by enum member name (`v1`) or value (`"2024-01-01"`;
  a member name wins over another member's value); unset, the latest version (the last enum member) is
  generated. Unlike `@typespec/openapi3`, which writes a document per version, one emit generates one version:
  emit twice (e.g. two `tspconfig` files, or `--option "@abhigyakrishna/tspgen-kotlin.version=v1"` with another
  output directory and package) to generate several.
- A `version` that is not a version of a versioned service is an error (`unknown-version`, listing the valid
  versions) and **nothing is written** — the previous output (and its manifest) is left as it was. The same
  holds when `@typespec/versioning` cannot be loaded (`module-load-failed`).
- Types, properties, operations, parameters, enum members and union variants follow `@added`, `@removed`,
  `@renamedFrom`, `@madeOptional` / `@madeRequired`, `@typeChangedFrom` and `@returnTypeChangedFrom` at that
  version; everything else (docs, routes, `@encodedName`, `@meta`, `@Kotlin.*` / `@TS.*`) is kept. Plugins and
  targets receive the IR of that version.
- The version is exposed as a constant, only for versioned services: Kotlin `const val API_VERSION = "2024-06-01"`
  in `models/<pkg>/models/ApiVersionConstants.kt` (not `ApiVersion.kt`, the file of a version enum named
  `ApiVersion`); TypeScript `export const API_VERSION = "2024-06-01"` at the end of
  `models/index.ts` (or `types.ts` with `layout: single-file`). With several versioned services each gets
  `<SERVICE>_API_VERSION` (`PET_STORE_API_VERSION`). Clients do not send the version by themselves (use a
  header/query parameter declared in the spec, or `ClientConfig` / `defaultRequest` headers). The version enum
  itself is generated only if a model or parameter references it. In TypeScript a generated type named like a
  constant (`@TS.name("API_VERSION")`) is an error (`api-version-name-clash`) and the constant is left out,
  rather than one silently shadowing the other.
- Several services: `version` applies to every versioned service; a versioned service without that version is
  an error (`unknown-version`, see above), unversioned services are generated as-is, and `version` without any versioned service warns `unused-version`. A service using another
  library's version through `@useDependency` is generated against that version.
- A template model stays generic (`Page<T>`) when its instances have every property of the declaration at the
  generated version; when the version removes some (`@added(Versions.v2) next?: string` generated at `v1`), it
  gets one model per instance (`PagePet`), as for other non-generic templates.
- A type used by two services at different versions (a versioned service and a `@useDependency` service
  pinned to an older version of it) is generated once, from the first service, with a `version-conflict`
  warning.
- Decorator diagnostics that only one version has (e.g. `@maxLength` on a property whose type is `int32` before
  a `@typeChangedFrom`) are reported when that version is generated.
- `@typespec/http` checks routes over all versions at once: replacing an operation with another on the same
  verb and route in a later version (`@removed(Versions.v2) op getV1` + `@added(Versions.v2) op getV2`) fails
  with `@typespec/http/duplicate-operation`, whatever version is generated. Mark both `@sharedRoute`, or keep
  one operation and change it with `@returnTypeChangedFrom` / `@typeChangedFrom` / `@added` parameters.

## Server-sent events

```tsp
import "@typespec/sse";   // with @typespec/events and @typespec/streams

@TypeSpec.Events.events
union PetEvents {
  added: Pet,                                            // event: added, JSON data
  @TypeSpec.Events.contentType("text/plain") note: string,
  count: int32,
  @TypeSpec.Events.contentType("text/plain") @TypeSpec.SSE.terminalEvent "[done]",   // unnamed: event "message"
}

@route("/feed") interface Feed {
  @get watch(@query room: string): TypeSpec.SSE.SSEStream<PetEvents> | NotFound;
  @get @route("/raw") raw(): { @header contentType: "text/event-stream"; @body body: string };   // untyped
}
```

`@typespec/streams`, `@typespec/events` and `@typespec/sse` (0.86.x, matching `@typespec/http` 1.16) are
**optional peer dependencies** of `@abhigyakrishna/tspgen-core`: install them next to tspgen to use
`SSEStream<…>`. The emitter pipeline imports them (dynamic `import()`, from tspgen-core's location) only when the
spec uses streams or events, and hands them to `buildApiIR` (`BuildOptions.sse`, from `loadSseLibraries()`);
core has no top-level await, so it can still be `require`d. Without them (or when tspgen cannot resolve them) every
`text/event-stream` response is an untyped stream, and an `SSEStream<…>` operation warns
`sse-libraries-missing`; code calling `buildApiIR` directly without `sse` gets the same untyped fallback. Specs
without event streams generate exactly what they did before.

Each variant of an `@events` union is one event: its name is the SSE `event:` (an unnamed variant is the default
`message` event), its payload the variant type — or the `@data` property of an event envelope (the envelope's
other properties are not sent) — encoded as its `@contentType`, by default `text/plain` for strings and string
literals and `application/json` otherwise. A literal payload (`"[done]"`) identifies its event by its data, so
several unnamed variants can share the `message` event. `@terminalEvent` ends the stream: the server stops after
sending it and the clients stop reading. Any other `text/event-stream` response (no `SSEStream`) is an **untyped**
stream of `SseMessage { data, event?, id? }`. An `@events` union is generated only for the streams (and other types)
that use it; used as a regular JSON type (a model property, a request or JSON response body) it warns
`events-in-json`, as the event types have no JSON form.

| Target | Typed stream (`SSEStream<PetEvents>`) | Untyped stream |
|---|---|---|
| Kotlin models | `sealed interface PetEvents` (not `@Serializable`) with `data class Added(val data: Pet)`, …, `data object Done` for literal payloads; a class whose name would shadow a payload type (`userConnect: UserConnect`) gets an `Event` suffix | `data class SseMessage(data, event?, id?)`, generated once when used |
| Ktor server | `suspend fun watch(room: String): Flow<PetEvents>` | `Flow<SseMessage>` |
| Ktor client | `fun watch(room: String): Flow<PetEvents>` — cold: collecting it sends the request | `Flow<SseMessage>` |
| TypeScript models | `type PetEvents = \| { event: "added"; data: Pet } \| …` (zod: `z.discriminatedUnion("event", …)`, `z.union` when event names repeat) | `interface SseMessage { event?; data; id? }` |
| Next.js grouped client | `async *watch(params, options?): AsyncIterable<PetEvents>` | `AsyncIterable<SseMessage>` |
| Next.js flat client | `async *watch(query, init?: { signal?: AbortSignal }): AsyncIterable<PetEvents>` | `AsyncIterable<SseMessage>` |

- **Ktor server.** The route calls the service first and streams the returned flow afterwards, so an exception
  the service throws before returning the flow (e.g. `NotFoundException`) still answers with its status; once the
  flow is being collected the response has started and an exception only ends the stream. Pick the writer with the
  `sse` option, or per operation / interface / namespace with `@@meta(Feed.watch, "kotlin:ktor-server", #{ sse:
  "plugin" })` (other values warn `invalid-meta` and fall back to the option):
  - `text-writer` (default, no extra dependency): writes `text/event-stream` itself with `respondBytesWriter`
    (non-blocking), one `event:` / `data:` (one line per line of data) / blank-line block per event, flushed per
    event;
  - `plugin`: responds through the `ktor-server-sse` plugin (`SSEServerContent`, `ServerSentEvent`s); add
    `io.ktor:ktor-server-sse` to your build. The generated module installs `SSE` when any operation uses it; with
    `features.module: false`, `install(SSE)` yourself.

  Both work with every routing style and handler shape (routes stay regular `get`/`post`/… routes, inside the
  `authenticate(...)` wrapper generated from `@useAuth` like any other route) and send the `sse-headers` (default
  `Cache-Control: no-store` and `X-Accel-Buffering: no`; a configured map replaces them, `{}` sends none;
  `Content-Type`, `Content-Length`, `Transfer-Encoding` and `Upgrade` are rejected). JSON payloads are encoded with
  `serverJson`, the Json the generated module's content negotiation installs, so an event carries exactly the JSON a
  REST response would; with `features.module: false` and your own content negotiation, events still use `serverJson`.
  Text payloads are sent
  as-is (strings) or as their wire string (numbers, java.time values, enums); CR and CRLF line breaks in data
  become separate `data:` lines, so clients receive them as LF. CR and LF are removed from `SseMessage` event
  names and ids (they would otherwise forge fields or events) and an id containing NUL is dropped. Streams answer
  200 whatever success status the operation declares. No heartbeat / keep-alive comments are sent: a client that
  disconnects while the stream is idle is noticed on the next write (which cancels the service's flow).
- **Ktor client.** Collecting the flow executes the request (`Accept: text/event-stream`); a non-2xx response
  throws the operation's usual exceptions before any event; events are parsed by a small generated reader
  (`ClientSupport.kt`: CRLF/LF/CR line ends, comments, `retry:`, multi-line data, lines and UTF-8 characters split
  across reads, a leading byte order mark) and decoded by event name; unknown events are skipped; a terminal event
  ends the flow; cancelling the collection closes the response. JSON payloads decode with the Json given to
  `<service>Defaults(format)` (e.g. `ignoreUnknownKeys`), else that function's default; a malformed payload throws
  from the flow (`SerializationException`, `NumberFormatException`, …), as does a line or event over 1 MiB
  (`IllegalStateException`). No Ktor SSE client plugin is needed. `HttpTimeout`'s `requestTimeoutMillis` covers
  the whole streamed response, so it cuts long streams: leave it unset (or infinite) for clients that stream.
- **Next.js clients.** The methods are async generators: the request is sent on the first iteration, with the
  usual auth/config headers and `Accept: text/event-stream`, and a non-2xx response throws the usual error there.
  JSON payloads are `JSON.parse`d and, in the grouped client, validated with the zod schema unless
  `validate: false`; unknown events are skipped; a terminal event ends the iteration. `break`ing out of
  `for await` cancels the response body; `RequestOptions.signal` (grouped) / `init.signal` (flat) aborts the
  request, rejecting the iteration with fetch's abort error. A payload that fails mid-stream — malformed JSON, a
  number or boolean text payload that isn't one, a zod validation error, a line or event over 1 MiB — throws from
  the iteration and ends it. `Accept: text/event-stream` is set only when the configured / per-call headers have no
  `accept`: a global `accept` header in `ClientConfig.headers` (or `ClientOptions.headers`) overrides it. `@useAuth`
  credentials are sent with stream requests like any other. React Query hooks (grouped and flat) and Server
  Actions skip streaming operations — call the client directly.
- Only the single success response of an operation can stream: a `text/event-stream` response next to other
  success responses or with response headers warns `unsupported-sse-response` and is treated as a text body.
- Not supported: other stream kinds (`JsonlStream`, `HttpStream<…, "application/jsonl">`), SSE request bodies,
  reconnection / `Last-Event-ID` (the clients report `id:` on `SseMessage` only), and sending `id:` / `retry:` from
  typed events. In Kotlin, a model of your own named `SseMessage` in the models package clashes with the untyped
  message class (`sse-message-conflict`), as does a TypeScript type named `SseMessage`; rename it with
  `@Kotlin.name` / `@TS.name`.

## Type mapping

The wire format belongs to the TypeSpec definition, the in-language type to the emitter options: options change
which type a language uses, never what it sends. A different wire form (an `int64` as a JSON string) is declared once
with `@encode(string)`, which both languages honour.

| TypeSpec | TypeScript | zod | Kotlin |
|---|---|---|---|
| `int8` / `int16` / `int32` | `number` | `z.number().int()` | `Byte` / `Short` / `Int` |
| `int64`, `integer`, `safeint` | `number` | `z.number().int()` | `Long` |
| `uint8` / `uint16` / `uint32` | `number` | `z.number().int()` | `Short` / `Int` / `Long` (widened to hold the unsigned range) |
| `uint64` | `number` | `z.number().int()` | `ULong` |
| `float32`, `float64`, `float`, `numeric` | `number` | `z.number()` | `Float`/`Double` |
| `decimal`, `decimal128` | `string` | `z.string().regex(/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/)` | `BigDecimal` (`decimal: big-decimal`, default) or `String` (`decimal: string`); both write a JSON string |
| `@encode(string)` on `int64`, `integer`, `safeint` | `string` | `z.string().regex(/^-?\d+$/)` | `Long` with `@Serializable(with = LongAsStringSerializer::class)` |
| `@encode(string)` on `uint64` | `string` | `z.string().regex(/^\d+$/)` (no leading `-`) | `ULong` with generated `@Serializable(with = ULongAsStringSerializer::class)` |
| `utcDateTime` | `string`, or `Date` with `date-type: date` | `z.iso.datetime({ offset: true })` / `dateTimeCodec` | `Instant` |
| `offsetDateTime`, `plainDate`, `plainTime`, `duration` | `string` | `z.iso.*` | java.time / kotlin.time (`date-time`) |
| `scalar PetId extends string` | `string` | base schema | `String` (`scalar-style: inline`, default), `typealias PetId = String`, or `value class PetId(val value: String)` |
| `enum` / closed string-literal union | per `enum-style` | `z.enum(…)` | `enum class` (+ `UNKNOWN` with `features.enum-unknown`) |

**`@encode(string)`** on `int64`, `uint64`, `integer`, `safeint`, `decimal`, `decimal128` (property or scalar) sends
the number as a JSON string — the only exact `int64`/`uint64` for JavaScript clients. Kotlin honours it everywhere
JSON goes: model properties, and top-level request/response bodies, typed error bodies, event payloads and
multipart JSON parts (`BigId[]` → `["1"]`), with an explicit serializer where the type alone would lose it (see
the Ktor server's **JSON** paragraph). A scalar body with no JSON content type (`text/plain`, TypeSpec's default
for a scalar `@body`) is not JSON and is left as it is. Any other encoding
(`unixTimestamp`, `rfc7231`, `base64url`, `@encode(string)` on other scalars or on a non-scalar shape such as a
union) warns `unsupported-encoding` and keeps the default JSON form; a scalar's own default (`rfc3339` on dates,
`ISO8601` on `duration`, `base64` on `bytes`) is accepted silently. The warning is deduplicated per declaring
property or scalar (a `model … is …`/spread/template copy of the same declared `@encode` warns once, not per
copy). Kotlin annotates only direct properties and `List`/`Map` elements; type arguments of generic models
(`Page<BigId>`) are not annotated — use `scalar-style: value-class` there.

TypeScript `@minValue`/`@maxValue` on `decimal`/`decimal128` (always a string) are not checked and warn
`unsupported-bounds`; the same bounds on an `@encode(string)`-encoded `int64`/`uint64`/`integer`/`safeint` **are**
checked, with a `BigInt`-comparing `.refine()` since the value can exceed `Number`'s safe range.

**TypeScript `enum-style`** (per declaration: `@meta("typescript", #{ enumStyle: "…" })`):

| Value | `enum PetKind { dog, cat }` | zod |
|---|---|---|
| `union-const` (default) | `type PetKind = "dog" \| "cat"` + `const PetKind = { Dog: "dog", Cat: "cat" } as const` | `z.enum(["dog", "cat"])` |
| `union` | the type only | same |
| `enum` | `enum PetKind { Dog = "dog", Cat = "cat" }` — not erasable syntax (`erasableSyntaxOnly`, Node type stripping), and literals are not assignable to it | `z.enum(PetKind)` |
| `const-array` | `const PetKindValues = ["dog", "cat"] as const` + `type PetKind = (typeof PetKindValues)[number]` | `z.enum(PetKindValues)` |

The `values` meta renames the tuple (`const-array`) or adds one (other styles); a tuple named like another generated
type is a `duplicate-type-name` error. Extensible unions (`"a" | "b" | string`) stay `"a" | "b" | (string & {})`.

**TypeScript `declaration: type`** emits `export type Pet = { … };` (generic `Page<T>`, supertypes as `Base & { … }`);
schemas are unchanged. **`features.readonly`** makes every model property `readonly` (arrays stay `T[]`); override it
per model or namespace with `@meta("typescript", #{ features: #{ readonly: true } })`; a property's own
`@meta("typescript", #{ readonly: false })` still wins.

**TypeScript `date-type: date`** maps `utcDateTime` (and scalars extending it) to `Date` through the zod 4 codec
`dateTimeCodec` (`models/codecs.ts`, or `types.ts` in the single-file layout), so it needs `features.zod`
(without it: `unsupported-feature` warning, dates stay strings). `offsetDateTime` (a `Date` drops the offset),
`plainDate`, `plainTime` and `duration` stay strings. `dateUse`'s TypeScript type text is `globalThis.Date`, so a
generated type named `Date` cannot shadow it — no rename needed. `JSON.parse` never produces a `Date`, so the
clients decode and encode wherever JSON meets values:

- grouped client: responses, typed errors and events whose schema contains a date are parsed **even with
  `validate: false`** (the schema is a codec, so it always runs); `Date` query, path, header and cookie parameters
  and multipart text parts are sent as `toISOString()`; `Date` response headers become `Date`s (an unparsable
  header value becomes an `Invalid Date`, not an error); request bodies use `JSON.stringify` (`Date.toJSON()`) with
  no schema check, so grouped request bodies containing an invalid `Date` are not validated and an invalid `Date`
  serializes as `null`; Server Actions check `Date` input with `safeEncode` and forward the checked, key-stripped
  data decoded back to `Date`s (Next.js serializes `Date` across the action boundary); a per-status error factory
  whose body fails to decode against its schema falls back to the typed error class carrying the raw (undecoded)
  body instead of throwing or discarding it;
- flat client: results, events and the error model are decoded with their schema, with the same raw-body fallback
  on a decode failure; `features.validate` checks date bodies and query objects with `z.encode`; query, path and
  multipart values are sent as `toISOString()`.

Because a codec schema always runs (grouped: even with `validate: false`; flat: any result whose schema contains a
`Date`), decoding a `date-type: date` response also fully validates it — not just the `Date` fields. An enum member
the client doesn't know about, or a malformed `decimal` string, throws `ZodError` there even though it would
otherwise pass through unvalidated. TypeScript has no `enum-unknown` equivalent (see Kotlin's
`features.enum-unknown` below); for forward-compatible enums write `union { "a", "b", string }` instead (rendered
`"a" | "b" | (string & {})`, always accepted).

A `Base` model reached only through `@meta("typescript", #{ supertypes: #[...] })` (`interface X extends Base`) is
cast onto the schema rather than validated, so a `Date` field inherited that way is typed `Date` but not decoded by
the schema.

**Kotlin `decimal: big-decimal`** (default) generates `BigDecimalSerializer` in `ModelSerializers.kt`: it writes
`toPlainString()` as a JSON string and reads a JSON string or number. Round-tripping a decimal through `BigDecimal`
can change its scale or textual representation (e.g. trailing zeros, exponent form), so a value forwarded
unmodified is not guaranteed to serialize back byte-for-byte; `decimal: string` keeps the original string as-is.
Parameters use `toBigDecimal()` / `toPlainString()`; `@minValue`/`@maxValue` compare with `BigDecimal("n")`;
defaults are `BigDecimal("n")`.

**Kotlin `features.enum-unknown`** gives each string enum a last member `UNKNOWN` (`Unknown` with PascalCase members;
`UNKNOWN_` if a member already has the name) and a nested serializer: unknown wire values (bodies, events,
parameters) decode to it, and encoding it throws `SerializationException`. Default off — a server should answer an
unknown input value with 400; turn it on for client-only projects, or per enum/namespace with
``@meta("kotlin", #{ features: #{ `enum-unknown`: true } })``. Numeric enums are unaffected. TypeScript has no
`enum-unknown` equivalent — use `union { "a", "b", string }` for a forward-compatible enum there (see
`date-type: date` above for how that interacts with zod validation).

**Kotlin `scalar-style`** (per scalar: `@meta("kotlin", #{ scalarStyle: "…" })`, `@Kotlin.type` still wins):
`inline` (default) uses the base type; `typealias` declares `typealias PetId = String`; `value-class` declares
`@Serializable @JvmInline value class PetId(val value: String)` whose `init { }` checks the scalar's own
constraints (with `features.validation`) — constraints declared on a base scalar further up an `extends` chain are
not carried onto the value class, only the most-derived scalar's own. Value classes serialize as their value (the
wire is unchanged); Ktor parameters convert through the base type (`PetId(it)`, `id.value`); defaults render
`PetId("…")`. A property-level `@encode(string)` on a use of a value-class scalar whose own declaration is not
already string-encoded generates `<Name>AsStringSerializer` in `ModelSerializers.kt` — wrapping
`LongAsStringSerializer` (`Long`-based scalars) or the generated `ULongAsStringSerializer` (`ULong`-based) — once
per scalar, and annotates that use `@Serializable(with = <Name>AsStringSerializer::class)`, so the wire matches
the use's own `@encode(string)` while the class keeps its one declaration. `String`/`BigDecimal`-based value
classes (`decimal`/`decimal128`) already write a JSON string, so a use's `@encode(string)` there is a no-op.

## Decorators

```tsp
import "@abhigyakrishna/tspgen-kotlin";

@Kotlin.name("Customer")                 // rename the generated declaration/property/operation
@Kotlin.annotate("@Suppress(\"unused\")") // add annotations (repeatable)
model User {
  @Kotlin.type("java.util.UUID") id: string;   // map to any Kotlin type (import added)
}

@Kotlin.packageName("com.acme.shared")    // place a model/enum/union in another package
model Money { amount: string }
```

`@Kotlin.type` on a templated model maps every instance with its arguments
(`@@Kotlin.type(Shop.Page, "com.acme.core.Page")` → `Page<Node>`), and on a scalar maps every use of it
(`@@Kotlin.type(Shop.isoInstant, "com.acme.core.IsoInstant")`). Mapped types are never generated.

TypeScript: `@TS.name("Customer")` renames a generated type; `@TS.type("Decimal", "decimal.js")` maps a
model, scalar, enum, union or property to an external type (module optional, e.g. `@TS.type("Date")`). A
module starting with `.` is resolved from the emitter's output root and rebased into a relative import for
each generated file; any other module (a package name) is used verbatim. `@TS.type` on a templated model maps
every instance with its arguments (`@@TS.type(Shop.Page, "Page", "../page")` → `Page<Node>`, imported from
`../page` relative to the output root); mapped types are never generated.

> **Behaviour change**: relative `@TS.type` modules (starting with `.`) are now resolved from the emitter's
> output root and rebased per file. Previously they were used verbatim, i.e. relative to each importing file,
> which broke for any file not at the output root (e.g. `models/<Name>.ts` or `api/*.ts`).

## Language-specific metadata

Attach metadata for one language or target with `@meta(scope, data)` (namespace `TspGen`, available once
any tspgen emitter library is imported). Scopes: `"*"`, a language (`"kotlin"`, `"typescript"`) or a
target (`"kotlin:ktor-server"`, `"kotlin:ktor-client"`, `"typescript:ts-nextjs-client"`).

```tsp
using TspGen;

@meta("kotlin", #{ annotations: #["@Entity"], imports: #["jakarta.persistence.Entity"], table: "pets" })
@meta("typescript", #{ features: #{ readonly: true } })
model Pet { id: int64 }
```

Keep it out of the API definition with augment decorators in a separate file:

```tsp
// kotlin.tsp — compile this file instead of main.tsp
import "@abhigyakrishna/tspgen-kotlin";
import "./main.tsp";
using TspGen;

@@meta(PetStore.Pets.remove, "kotlin:ktor-server", #{ authenticate: "api" });
@@meta(PetStore.Toy, "kotlin", #{ implements: #["java.io.Serializable"] });
```

Resolution: `"*"` → language → `language:target`, key by key (later wins; arrays concatenate).
For every `@meta` key, an operation or interface inherits from every namespace enclosing it (outermost first),
then its own scope (interface, then operation) — the same in Kotlin and TypeScript. Models, enums and unions
only inherit the `features` key from their enclosing namespaces; any other key set on a namespace has no effect
on them. `wrap`, `routeSet` and `features.nest-routes` require `routing-style: dsl`; with any other style the
target fails (a hard error, not a warning) rather than dropping guards. `features` objects merge key by key
across scopes and levels.
Built-in keys (wrong types produce an `invalid-meta` warning; unknown keys pass through untouched):

| Scope | Key | On | Effect |
|---|---|---|---|
| `kotlin` | `annotations: string[]` | types, properties, enum members, operations | annotation lines |
| `kotlin` | `imports: string[]` | types | extra imports |
| `kotlin` | `implements: string[]` | models, sealed hierarchies | extra supertypes (FQN; qualified automatically on name clashes) |
| `kotlin` | `checks: string[]` | models | statements appended to the data class `init { }` block (`init` is reserved in TypeSpec); throw `ModelCheckException("…")` (models package) for the Ktor server to answer `FailedCheck` with the message |
| `kotlin` | ``features: #{ `enum-unknown` }`` | enums, string-literal unions, namespaces | override `features.enum-unknown` |
| `kotlin` | `scalarStyle: "inline" \| "typealias" \| "value-class"` | scalars | override `scalar-style` |
| `kotlin` / `typescript` (or `*`) | `notBlank: boolean` | string properties | an `x.isNotBlank()` check, emitted with or without `features.validation`; `@minLength(1)` alone only checks `isNotEmpty()`, matching the wire contract; TypeScript: `.regex(/\S/)` on the zod schema |
| `kotlin:ktor-server` | `authenticate: string \| string[]` | operations, groups | route wrapped in `authenticate(...) { }` (install Ktor `Authentication`); replaces the wrapper generated from `@useAuth` |
| `kotlin:ktor-server` / `kotlin:ktor-client` | `annotations: string[]` | operations, groups | annotations on service / client methods |
| `kotlin:ktor-server` | `wrap: string[]` | namespaces, groups, operations | route-builder calls wrapped around routes, outermost first (dsl style); duplicates within one chain are dropped and shared prefixes share one block |
| `kotlin:ktor-server` | `imports: string[]` | namespaces, groups, operations | imports added to the routes file (for names used in `wrap`/`context`; a `wrap` call to `authenticate(...)` needs `io.ktor.server.auth.authenticate` here — only the `authenticate` key adds it automatically) |
| `kotlin:ktor-server` | `context: { name, type, expr, replaces? }[]` | namespaces, groups, operations | service parameters supplied by `expr` in the route handler (`call` in scope); `replaces` (string or list) hides those HTTP parameters from the service signature — never a path parameter — and the entry applies only where they all exist; names are backtick-escaped if they are Kotlin keywords, `call`/`service`/`resource` are reserved, and later entries with the same name win |
| `kotlin:ktor-server` | `routeSet: string` | namespaces, groups, operations | move routes into `fun Route.<unit><RouteSet>Routes(service)` (dsl style); with `features.module: true` the generated module mounts every route function, including per-routeSet ones; a name that isn't a valid Kotlin identifier fails the target |
| `kotlin:ktor-server` | `multipart: "buffered" \| "streaming" \| "raw"` | namespaces, groups, operations | how multipart and file bodies reach the service (see Uploads); overrides the `multipart` option |
| `kotlin:ktor-server` | `maxUploadSize: integer` | namespaces, groups, operations | largest multipart part / buffered multipart request / buffered file body in bytes (larger → 413); overrides the `max-upload-size` option |
| `kotlin:ktor-server` | `sse: "text-writer" \| "plugin"` | namespaces, groups, operations | how a server-sent event stream is written (see Server-sent events); overrides the `sse` option |
| `typescript` | `readonly: boolean` | properties | `readonly` property (wins over `features.readonly`); on a model: `invalid-meta`, use `features: #{ readonly: true }` |
| `typescript` | `features: #{ readonly }` | models, namespaces | override `features.readonly` |
| `typescript` | `enumStyle: "union-const" \| "union" \| "enum" \| "const-array"` | enums, string-literal unions | override `enum-style` |
| `typescript` | `supertypes: { name, from? }[]` | models | `interface X extends A` (zod schema cast; inherited members, including `Date` fields, are not validated/decoded) |
| `typescript` | `jsdoc: string[]` | declarations, properties | extra JSDoc lines |
| `typescript` | `values: string` | enums, string-literal unions | an identifier different from the type's own name → `export const <values> = [...] as const; export type X = (typeof <values>)[number]`; otherwise ignored with an `invalid-meta` warning |
| `typescript:ts-nextjs-client` | `next: { revalidate?, tags? }` | operations, groups | default Next.js fetch options |
| `typescript:ts-nextjs-client` | `staleTime: number` | GET operations, groups | default `staleTime` in `queryOptions` |
| `kotlin` / `typescript` / `go` (or `*`) | `features: { <key>: boolean }` | namespaces, interfaces, operations, models, enums, unions, scalars | per-declaration value of a feature with an `@meta` override (`docs`, `generics`, Kotlin/Go `enum-unknown`, Go `validation`/`defaults`, TypeScript `readonly`; see Options reference); other keys, wrong types or disallowed places warn `invalid-meta` |

Templates read any metadata with `it.h.meta(item)` / `it.h.meta(item, "ktor-server")`; plugins use
`resolveMeta(item.meta, language, target)` from `@abhigyakrishna/tspgen-core`.

## Customizing output

**Template overrides.** Every file is rendered from [Eta](https://eta.js.org) templates addressed by
logical name. A file in `template-dir` with the same relative path wins over plugin, target and
language templates, so you can override one partial without forking:

| Template | Renders |
|---|---|
| `kotlin/file` | file skeleton (header, package, imports, body) |
| `kotlin/common/header` | the "generated" header comment |
| `kotlin/model/{data-class,sealed-interface,enum,typealias,value-class}` | model declarations (`value-class`: `scalar-style: value-class` scalars) |
| `kotlin/model/{events,sse-message,http-file,api-version}` | event unions, `SseMessage`, `HttpFile`, the `API_VERSION` constant |
| `kotlin/model/model-serializers` | `ModelSerializers.kt`: generated serializers (java.time, `BigDecimal`, …) and `modelSerializersModule` (0.1.x: `kotlin/model/java-time-serializers`) |
| `kotlin/api/{result,exception,api-exception}` | shared result/error types |
| `ktor-server/{service,module,support,part-class}` | server interface, module, runtime helpers (`serverJson`, parameters, uploads, events), streaming multipart part classes |
| `ktor-server/errors` | `<Service>Errors.kt`: `StatusPagesConfig.<svc>Errors()` (0.1.x rendered it in `ktor-server/module`) |
| `ktor-server/routes/{dsl,dsl-nodes,dsl-route,resources,resources-route,respond}` | routing styles and the response partial |
| `ktor-client/{client,response,api-client,support}` | client classes |
| `ts/file`, `ts/common/header`, `ts/barrel`, `ts/types` | TypeScript file skeleton, header, barrels, single-file layout |
| `ts/model/{interface,alias,enum}`, `ts/api/{errors,results}`, `ts/api-version` | TypeScript models and shared api types |
| `ts/codecs` | `dateTimeCodec` and friends (`date-type: date`) |
| `ts-nextjs/{core,group,index}` | fetch runtime and clients (grouped style) |
| `ts-nextjs/{auth,sse-runtime,without-undefined}` | partials shared by both styles: `@useAuth` credentials, event-stream decoding, `undefined`-key stripping |
| `ts-nextjs/{queries,hooks}` | TanStack Query (grouped style) |
| `ts-nextjs/{actions,action-result,server-client}` | Server Actions |
| `ts-nextjs/flat-client`, `ts-nextjs/{flat-queries,flat-hooks}` | flat style: `client.ts`, and its TanStack Query `queries.ts` / `hooks.ts` |

Templates receive the file data as `it`, emitter options as `it.ctx.options`, resolved feature values as
`it.features` (`{ [key]: boolean }` — the producing target's features layered over the language's, from
`FileSpec.features`), the banner text as `it.ctx.headerText` (already resolved from `features.header` and
`header-text`, `undefined` when the header is off — `common/header.eta` renders it with
`<% if (it.ctx?.headerText) { %><%~ it.h.lineComment(it.ctx.headerText) %><% } %>`), and helpers as `it.h`
(`it.h.kdoc`, `it.h.str`, `it.h.ktorServer.*`, `it.h.ktorClient.*`, plus plugin helpers).

**Plugins.** A plugin is a module whose default export is a `TspGenPlugin`:

```js
// tspgen/audit.js
import { fileURLToPath } from "node:url";

export default {
  name: "audit",
  languages: ["kotlin"],
  // 1. mutate the language IR
  transformIR(ir) {
    for (const d of ir.declarations) if (d.kind === "data-class") d.annotations.push("@Audited");
  },
  // 2. add/remove/modify planned files
  files(files) {
    files.push({ path: "server/README.md", template: "audit/readme", data: {} });
  },
  // 3. extra template layer and helpers (it.h.shout)
  templates: fileURLToPath(new URL("./templates", import.meta.url)),
  helpers: { shout: (s) => s.toUpperCase() },
  // 4. register extensions, e.g. a custom Ktor routing style
  setup(ctx) {
    ctx.registry.register("ktor-server.routing-style", "company", {
      template: "company/routes",                 // your template, receives { unit, options }
      imports: () => ["io.ktor.server.routing.Route"],
    });
  },
  // 5. declare a feature of your own: set with features: { audited: true } in the language's features: block,
  //    read in transformIR/files/templates as it.features.audited (a duplicate-feature error if the language or
  //    another plugin already declares the key)
  features: { audited: { default: false, description: "Add @Audited to every model." } },
};
```

Use it with `routing-style: company`.
The routes template also receives `extras` (`ServerOpExtras` per operation id); render `extras[op.id].auth[0]`, when
present, as the route's `authenticate(...)` wrapper. A style that renders only the provider names in
`extras[op.id].authenticate` gets a warning `auth-wrapper-not-rendered` for routes whose wrapper needs more (a
`strategy`, `optional = true` or an `auth-providers` expression), as does overriding a built-in routes template
that renders wrappers.

**TypeScript plugins.** Plugins (and custom targets) may be `.ts`, `.mts` or `.cts` files, loaded through Node's
built-in type stripping (Node >= 22.18 or 23.6), so there is no build step. That limits them to erasable syntax: no
`enum`, `namespace` or parameter properties, and relative imports spell out `.ts`; set `"erasableSyntaxOnly": true`
in the plugin's tsconfig to have `tsc` enforce it. Import tspgen's types with `import type`, which is erased:

```ts
// tspgen/audit.ts
import type { TspGenPlugin } from "@abhigyakrishna/tspgen-core";
import type { KotlinIR } from "@abhigyakrishna/tspgen-kotlin";
import type { KtorServerMeta } from "@abhigyakrishna/tspgen-kotlin-ktor-server";

export default {
  name: "audit",
  languages: ["kotlin"],
  transformIR(ir) {
    for (const op of ir.services.flatMap((s) => s.groups).flatMap((g) => g.operations)) {
      const server: KtorServerMeta = op.meta["kotlin:ktor-server"] ?? {};
      op.meta = { ...op.meta, "kotlin:ktor-server": { ...server, wrap: [...(server.wrap ?? []), "audited()"] } };
    }
  },
} satisfies TspGenPlugin<KotlinIR>;
```

`KtorServerMeta` types the `kotlin:ktor-server` metadata keys (`wrap`, `imports`, `context`, `authenticate`,
`routeSet`, `annotations`).

**Fitting an existing codebase.** `e2e/house-style` shows the full combination: namespace→package mapping,
`errors: thrown`, validation, `<Feature>Api` interfaces without a generated module, and a small plugin
(`tspgen/permissions.ts`, type-checked with its own tsconfig) that adds `authenticate`/`requirePermission` wrappers and an `actorId` context
parameter to every operation. Plugins that edit operation metadata in `transformIR` must replace scope objects
rather than mutate them, because operations of one group can share them. It also has a TypeScript half (`ts/`):
single-file layout, `errors: thrown`, and a flat client with an `error-model`, checked with `tsc` (strict flags)
and vitest.

## Adding a language or library

- **New server/client library for an existing language:** publish a package whose default export is a
  `Target<KotlinIR>` (`name`, `kind`, `language: "kotlin"`, `templates`, `helpers`, `optionsSchema`,
  `files(ir, ctx)`), then list it under `targets`. See `packages/kotlin-ktor-client` for a compact example. A
  target can declare its own on/off gates with `features` (a `FeatureSet`, merged into `optionsSchema.properties.features`
  and read from `ctx.features` in `files(ir, ctx)`) and rename option keys moved since an earlier release with
  `movedOptions` (checked before the target's own options are validated):
  ```ts
  export default {
    name: "my-server",
    kind: "server",
    language: "kotlin",
    files(ir, ctx) { return ctx.features.values.retries ? [/* … */] : [/* … */]; },
    features: defineFeatures({ retries: { default: false, description: "Retry failed requests." } }),
    movedOptions: { "old-key": "new-key" },
  } satisfies Target<KotlinIR>;
  ```
- **New language:** create an emitter package with a `LanguageModule` (`transform(apiIR) → YourIR`,
  base `templates`, `helpers`, optional `format`) and a built-in models target, and call `runPipeline`
  from `$onEmit`. Core (IR, plugins, templates, targets, manifest) is reused unchanged.

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
| `Http.File` bodies and multipart operations previously generated broken output: `Http.File` was emitted as a plain model (`File`) and multipart/file bodies were JSON-encoded regardless of target; both now generate working uploads (see Uploads) | none (the previous output could not upload) |
| The flat client no longer rejects an operation for having a multipart or file body (`flat-client-unsupported`), and the `non-json-body` warning no longer fires for one | none |
| Specs using `@useAuth` get `authenticate(...)` route wrappers on the Ktor server (providers named after the scheme ids, see Authentication); a route whose `wrap` meta already calls `authenticate(...)` gets both, and then accepts either provider | `generate-auth: false` on the Ktor server target |
| `ServerOpExtras` (routes template data `extras[op.id]`): `authenticate` still lists the provider names of the route's `authenticate(...)` wrapper, now also those generated from `@useAuth` (the scheme ids); the full wrapper call is in the new `auth` (and `authProviders`, `authStrategy`, `authOptional`). A plugin routing style or overridden routes template rendering `authenticate` alone keeps routes protected, but loses `strategy`/`optional`/`auth-providers` expressions: warning `auth-wrapper-not-rendered` | render `extras[op.id].auth[0]` as the wrapper, or `generate-auth: false` |
| Specs using `@useAuth` get a `<Service>Auth` type and `auth` option in the Next.js clients (`ClientConfig<Auth>` / `ClientOptions<Auth>` become generic); in the flat client a model named `<Service>Auth`, `AuthScheme`, `AuthEntries`, `resolveAuth` or `base64`, or an operation named `auth`, is now a clash | none needed for the runtime (no `auth` → no credentials added); rename clashing names with `@TS.name` |
| Every flat client method has a new optional trailing parameter `init?: { signal?: AbortSignal }` (after the query object; named `requestInit`/`options`/`init2`… when a parameter already uses `init`), and `fetch` gets `signal` when one is passed; positional calls are unaffected, but code relying on the exact parameter list (e.g. `Parameters<typeof api.readNode>`, wrappers spreading `...args`) sees the extra parameter | none (ignore the parameter) |
| A flat method whose path parameter or body is named like a reserved word (`class`) — previously an invalid signature — now names it `classValue` | none (the previous output did not compile) |
| A generated type named `AbortSignal` is reported as a flat-client name clash (`flat-client-name-clash`), since the new `init` parameter uses the global | rename it with `@TS.name` |
| The grouped client's React Query options for void GET/HEAD operations resolve `null` instead of `undefined` (which TanStack Query v5 rejects, so those queries always failed); their hook data type is `null` | none (the previous queries could not succeed) |
| `react-query: true` with `client-style: flat` generates `queries.ts` and `hooks.ts` instead of failing with `unsupported-in-flat-style` (unset or `false` still generates neither) | leave `react-query` unset |
| The flat client (JSON-only APIs too) passes fetch a `Headers` object (`new globalThis.Headers(options.headers)`) instead of a plain object, and its JSON `content-type` replaces a `Content-Type` from `ClientOptions.headers` in any letter case; a custom `fetch` reading `init.headers` as a plain object (`init.headers["authorization"]`) must read it through `new Headers(init.headers).get(…)` | none (adapt the custom fetch) |
| A `text/event-stream` response is now a server-sent event stream: previously its body was read as one string (Kotlin `String`, TypeScript `string` or rejected by the flat client); now the Ktor server takes a `Flow`, the Ktor client returns a `Flow` and the Next.js clients return `AsyncIterable`s (see Server-sent events) | none (declare a `text/plain` response to keep a single string) |
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

## Development

```bash
pnpm install
pnpm test        # build all packages, run unit + emitter tests (vitest)
pnpm e2e         # Kotlin: Gradle; TypeScript: tsc + HTTP tests; Go: generated client↔server tests
```

The e2e build needs JDK 17+ and Go 1.27+ (with a C compiler for the Go race detector).
The Go suite generates models and a client, then exercises both net/http and Gin servers over real HTTP.
After `pnpm build`, run it alone with `pnpm --filter tspgen-e2e-go test`.
If Gradle cannot download over IPv6 on your network, run
`JAVA_TOOL_OPTIONS=-Djava.net.preferIPv4Stack=true pnpm e2e`.

Design and plans live in `docs/superpowers/`.

## License

[MIT](LICENSE)
