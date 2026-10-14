# Go

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
subset is one fixed-status JSON success response per operation, JSON request bodies, and scalar, enum, and scalar-union path,
query, and header parameters. The client returns a typed success body or `HTTPError`; the server generates a `Service`
interface, `RegisterRoutes`, and `NewHandler`. Unsupported shapes, including auth, streaming, multipart, multiple success
responses, response headers, collection and model parameters, and nested discriminated models, produce TypeSpec diagnostics.

Models with additional properties (`...Record<T>`, `extends Record<T>`, `is Record<T>`) get an
`AdditionalProperties map[string]T` field. Unknown JSON keys land there, it is written after the declared properties,
and defaults, validation and strict-key checks apply to its values. Unions of scalars, literals and enums implement
`encoding.TextMarshaler`, so they can be path, query or header parameters. Text resolves to the most specific variant:
exact literal or enum value, then boolean, integer, float, other scalars, and finally string. Ranks follow the TypeSpec
scalar (an `integer` variant only takes integral text), and integer, float and boolean variants need their exact text
(no surrounding whitespace). Discriminated unions and unions with `bytes`, `unknown`, nullable, model, collection or
(non-enum) union variants get no text codec and cannot be parameters. Closed enum parameters accept only a member's
exact value text (`1`, not `01` or `+1`): unknown values get 400, or map to `UNKNOWN` with `features.enum-unknown`;
`UNKNOWN` cannot be sent. Open enums (literals widened by `string`) accept any text.

## Configuration

Models and every Go HTTP target have explicit options and feature gates, listed in the [Options reference](options.md).
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

## Generic client methods (Go 1.27+)

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

## Gin server

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

Handlers decode scalar, enum and scalar-union path/query/header parameters and JSON bodies, accept JSON media types including
`application/*+json`, and return 400 for malformed or trailing JSON, 415 for a non-JSON body, and 413 for a
body exceeding `max-body-size`. Optional empty bodies are accepted. Nonnullable bodies reject JSON `null`.
TypeSpec constraints, required properties, and nullability are checked by default; unknown model properties
are rejected unless `features.ignore-unknown-keys` is enabled.

Return `&server.HTTPError{StatusCode: 409, Body: body}` for an explicit JSON error response; wrapped errors
are supported. Other errors and response encoding failures return a sanitized 500. Service and response
encoding errors are also available through Gin's `Context.Errors` for application middleware. The Gin
target supports the same HTTP subset as the Go standard-library targets. Select one server target per
output directory, or give each target a separate `output-dir`.
