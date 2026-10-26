# Implementation compatibility matrix

This matrix describes the **current source, including unreleased Kotlin changes after 0.2.3**
(release baseline `65d2e3a`), audited against implementation and tests on 2026-10-26. It covers the shipped Kotlin, TypeScript and Go emitters, rather than the
capabilities of the TypeSpec compiler or other emitters. The repository pins
`@typespec/compiler` and `@typespec/http` **1.16.0**, and versioning/events/streams/SSE
libraries **0.86.0**; see the [core package](../packages/core/package.json).

TypeSpec terminology follows the official [language reference](https://typespec.io/docs/language-basics/overview/),
[models](https://typespec.io/docs/language-basics/models/) and
[unions](https://typespec.io/docs/language-basics/unions/) documentation. Those references
define the features; the source and tests linked below establish tspgen support.

## Reading the matrix

- **Yes**: implemented for the stated shape, within the shared limits below.
- **Opt-in**: implemented behind the named option, feature gate or metadata.
- **Partial**: restricted shapes, a lossy representation or target-specific behavior;
  read the qualification before relying on it.
- **No**: no implementation for that feature or target. This does not always imply a
  diagnostic: some metadata and type details are omitted.

Model support and HTTP support are separate. A Go union can work in a JSON body but
be rejected as a query parameter. A TypeScript model can be emitted even when the
flat client cannot represent an operation using it. “Yes” does not mean every
TypeSpec decorator, serialization format or protocol is supported.

## Languages and generated targets

| Language | Models | Client | Server | Guide |
|---|---|---|---|---|
| Kotlin | Yes: kotlinx.serialization data classes, enums and sealed types | Yes: Ktor `HttpClient` | Yes: Ktor service interfaces, routes and module | [Kotlin](kotlin.md) |
| TypeScript / JavaScript consumers | Yes: TypeScript interfaces/type aliases, enum styles; optional Zod and Effect schemas | Yes: Next.js/fetch, grouped or flat; optional TanStack Query, Server Actions and Effect | No server target; Server Actions call the generated client | [TypeScript](typescript.md) |
| Go | Yes: structs, enums, union codecs; separate models module | Yes: `net/http`, separate module | Yes: `net/http` or Gin, separate module | [Go](go.md) |
| Java, C#, Python, Rust, Swift, C/C++, Ruby, PHP | No shipped emitter | No | No | [Adding a language](extending.md) |

The [README package list](../README.md) identifies the emitter and target packages.
Kotlin's JVM output is not a Java source emitter, and TypeScript output is not a
separate JavaScript source target. The Go HTTP targets share the same supported
operation subset; choosing Gin does not expand TypeSpec feature coverage.

## Models and TypeSpec language features

| Feature | Kotlin | TypeScript | Go |
|---|---|---|---|
| Named, anonymous and recursive models | Yes: data classes | Yes: interfaces or `declaration: type`; lazy recursive schemas | Yes: structs and pointer references |
| Model `extends`, `is`, spread and intersections | Yes: ordinary inherited properties flattened; discriminated bases become sealed interfaces | Yes: inherited properties flattened; discriminated bases become unions | Yes: ordinary inherited properties flattened; discriminated bases become union wrappers |
| Arrays and pure `Record<T>` dictionaries | Yes: `List<T>`, `Map<String, T>` | Yes: `T[]`, `Record<string, T>` | Yes: slices, `map[string]T` |
| Declared properties plus additional `Record<T>` properties | Yes: typed additional-properties map and JSON codec; declared-key collisions rejected | No: extra-key index signature/schema not generated | Yes: `AdditionalProperties` map and JSON codecs |
| Optional properties (`?`) | Opt-in: `features.strict-optionals` preserves absence and rejects null for non-nullable fields; legacy nullable defaults otherwise | Yes: optional keys distinct from nullable values; schemas reject present `undefined` | Partial: pointers by default; `optional-fields: values` loses zero-value presence |
| Nullable types (`T \| null`) | Yes: `T?` | Yes: `T \| null` | Yes: pointer/nullability-aware JSON codecs |
| Distinguishing absent vs explicit null for optional nullable properties | Opt-in: `features.optional-presence` emits `OptionalValue<T?>` | Yes: absent key vs key containing `null` | Partial: optional and nullable values share pointers; no dedicated presence wrapper |
| String / boolean / numeric property literals | Yes: base scalar types with literal checks when validation is enabled | Yes: literal types and schemas | Yes: base scalar types with generated literal validation |
| String enums and closed string-literal unions | Yes: enum classes | Yes: configurable enum/union/const output | Yes: named scalar types, constants and codecs |
| Numeric enums | Opt-in: `features.numeric-enums` emits closed enums and numeric JSON codecs; legacy alias otherwise | Yes: numeric values and schemas | Yes: numeric enums and validation |
| Mixed string/numeric enum values | Opt-in: `features.numeric-enums` preserves string/numeric primitive kinds | Yes: mixed literals and schemas | No: `unsupported-type` error |
| Extensible string unions (`"a" \| string`) | Opt-in: `features.open-enums` emits string value classes with known constants; legacy alias otherwise | Yes: literals plus `(string & {})` | Yes: open enum accepts arbitrary strings |
| Untagged / mixed unions | Opt-in: `features.untagged-unions` emits JSON wrappers; otherwise `JsonElement` with `unsupported-union` warning | Yes: native unions and union schemas | Yes: variant structs with JSON codecs |
| `@discriminator` model hierarchies | Yes: sealed interfaces and derived classes | Yes: discriminated unions | Partial: tagged codecs; nested discriminated models rejected |
| `@discriminated` unions | Yes: model variants with `envelope: "none"` become sealed interfaces; object envelopes retain discriminator and payload names | Yes: envelope and non-envelope unions | Partial: envelope and non-envelope codecs; nested discriminated models rejected |
| Template models / generic models | Yes: safe templates remain generic | Yes: generic types and schema factories | Yes: generic structs |
| Complex template models and template unions | Yes: concrete specializations retain inherited, tuple and union shapes; union representation uses the gates above | Partial: concrete instances where generic output is unsafe | Partial: concrete instances where generic output is unsafe |
| Custom scalars extending built-ins | Yes: inline, type alias or value class; `@Kotlin.type` overrides | Yes: underlying type; `@TS.type` overrides | Yes: inline or alias; `type-names` configures names |
| `unknown` | Yes: `JsonElement` | Yes: `unknown` | Yes: `any` |
| Tuple value types (`[string, int32]`) | Yes: named classes with fixed-position JSON array codecs | No: unsupported tuple type warning | No: unsupported tuple type warning |
| Type aliases (`alias`) | Yes: compiler-resolved type; no separate alias declaration promised | Yes: same | Yes: same |

Implementation: [shared type collection](../packages/core/src/ir/type-collector.ts)
(`TypeCollector.ref`, `collectModel`, `genericRef`),
[Kotlin declarations](../packages/kotlin/src/transform/declarations.ts)
(`DeclarationBuilder`), [TypeScript declarations](../packages/typescript/src/transform/declarations.ts),
[Go declarations](../packages/go/src/transform/declarations.ts) and
[Go unions](../packages/go/src/transform/unions.ts).
Tests: [shared types](../packages/core/test/ir/types.test.ts),
[Kotlin lifecycle payloads](../packages/kotlin/test/lifecycle.test.ts),
[Kotlin model fidelity](../packages/kotlin/test/complete-models.test.ts),
[Kotlin transforms](../packages/kotlin/test/transform.test.ts),
[Kotlin client model fidelity](../packages/kotlin/test/client-models.test.ts),
[TypeScript transforms](../packages/typescript/test/transform.test.ts),
[Go unions](../packages/go/test/unions.test.ts) and
[Go additional properties](../packages/go/test/additional.test.ts).

Kotlin's opt-in untagged-union decoder requires exactly one matching variant;
overlapping shapes fail with `SerializationException`. It is not a replacement for
the discriminator/envelope wire contract of a tagged union.

## Scalars, serialization and validation

| Feature | Kotlin | TypeScript | Go |
|---|---|---|---|
| Fixed-width signed / unsigned integers | Yes: JVM numeric types, widened unsigned types and `ULong` | Partial: `number`; widths and 64-bit precision not preserved by the type | Yes: fixed-width Go numeric types |
| Unbounded `integer` / `numeric` | Opt-in: `features.precise-numbers` uses exact `BigInteger` / `BigDecimal` JSON numbers; legacy `Long` / `Double` otherwise | Partial: `number` and JavaScript precision limits | Yes: `json.Number` by default; `integer: int64` narrows the range |
| `decimal` / `decimal128` | Opt-in: `features.precise-numbers` preserves exact JSON numbers and explicit string encodings with either `decimal` mapping; legacy JSON strings otherwise | Partial: strings; numeric min/max bounds warn `unsupported-bounds` | Partial: configurable `json.Number`, `string` or `float64`; wire form/precision depend on option |
| Date/time/duration scalars | Yes: `java.time` by default, configurable `kotlin.time` mapping | Yes: strings; `utcDateTime` as `Date` requires `date-type: date` and `features.zod` | Partial: timestamp strings or `time.Time`; plain date/time and duration stay strings |
| JSON `bytes` | Yes: base64 `String` | Yes: base64 `string` | Yes: `[]byte` with JSON base64 encoding |
| `@encode(string)` on supported integers and decimals | Yes: explicit serializers preserve encodings in bodies, collections and generic properties | Yes: string representation and schemas | No: `unsupported-type` error for string-encoded numbers |
| Other `@encode` forms | Yes: standard date/time, duration, base64url, string-encoded numbers/booleans and delimited arrays; custom names warn | Partial: default encodings and the numeric string subset above | Partial: default encodings; string-encoded numbers rejected |
| `@encodedName("application/json", …)` | Yes: serial names | Yes: wire-name property keys | Yes: JSON tags |
| Property defaults | Yes: scalar, enum, tuple, collection, nested-model and unambiguous union constructor defaults; opaque type mappings remain application-owned | Partial: documented in JSDoc, not applied as runtime defaults | Yes: generated constructors and missing-property initialization; `features.defaults` gate |
| `@minLength`, `@maxLength`, `@minItems`, `@maxItems`, `@minValue`, `@maxValue`, exclusive numeric bounds, `@pattern` | Opt-in: `features.validation` (default true) checks literals, parameters, models and scalar collection elements | Opt-in: `features.zod` and/or `features.effect` schemas; client validation varies by target | Yes: `features.validation` model checks; server validation default on, client validation opt-in |
| External validation library integration | No separate validator target | Opt-in: Zod or Effect schemas | Opt-in: `features.validator` emits validator/v10 tags; tags cover a subset of generated checks |
| Unknown string enum values | Opt-in: `features.enum-unknown` decodes to a sentinel that cannot be encoded | Partial: closed enum schemas reject them; use an extensible union to accept them | Opt-in: `features.enum-unknown` sentinel; serialization rejects it |

Shared limits: the IR collects the nine constraint decorators listed above, not
every TypeSpec validation decorator. Inherited scalar constraints use the nearest declaration
for each bound or pattern. Kotlin retains exact numeric bounds and logical date/time/duration bounds,
including scalar collection elements; other targets have
their own validation coverage. Validation also depends on the mapped type. Custom opaque type mappings require
application-owned serialization/validation where generated schemas cannot know the
mapped type. See [type mapping](type-mapping.md) for encoding, date codecs and numeric
precision details, and [Go](go.md) for validator tag limits.

Implementation: [constraint and encoding collection](../packages/core/src/ir/type-collector.ts),
[Kotlin scalar mapping](../packages/kotlin/src/transform/type-map.ts),
[TypeScript scalar mapping](../packages/typescript/src/transform/type-map.ts),
[TypeScript property rendering](../packages/typescript/src/transform/declarations.ts),
[Go scalar mapping](../packages/go/src/transform/type-map.ts) and
[Go validation](../packages/go/src/validation.ts).
Tests: [Kotlin encoding](../packages/kotlin/test/encoding.test.ts),
[Kotlin model checks](../packages/kotlin/test/model-check.test.ts),
[Kotlin wire encodings](../packages/kotlin/test/wire-encodings.test.ts),
[Kotlin contract runtime tests](../e2e/kotlin/client/src/test/kotlin/ContractsE2ETest.kt),
[TypeScript constraints](../packages/typescript/test/constraints.test.ts),
[TypeScript Effect](../packages/typescript/test/effect.test.ts),
[Go options](../packages/go/test/options.test.ts) and
[Go validator tags](../packages/go/test/validator.test.ts).

## HTTP operations and transports

Here **Kotlin** means the Ktor client and server unless qualified; **TS grouped**
and **TS flat** are styles of the Next.js client. Go covers the net/http client,
net/http server and Gin server.

| TypeSpec / transport feature | Kotlin | TS grouped | TS flat | Go |
|---|---|---|---|---|
| Services, namespaces, interfaces and HTTP operations | Yes | Yes | Yes | Yes, within the JSON subset |
| Scalar path / query parameters | Yes | Yes | Yes | Yes, also enums and text-compatible scalar unions |
| Header / cookie parameters | Yes | Yes | No: `flat-client-unsupported` | Partial: scalar headers; cookies rejected |
| Array / model parameters | Yes: structured JSON parameter codecs, arrays and query serialization | Partial: target codecs and query serialization | Partial: query serialization; no header/cookie parameters | No: collections and model parameters rejected |
| JSON request and response bodies | Yes | Yes | Yes | Yes |
| Bodyless success (`void`, e.g. 204) | Yes | Yes | Yes | Yes, one fixed success status |
| Several success responses / response headers | Yes: generated result types | Yes: generated result types | No: requires one success and no response headers | No: requires one fixed success and no success response headers |
| Declared `@error` responses | Yes: typed results/exceptions | Yes: typed error classes, configurable | Partial: single configured error class, optional `error-model` | Yes: raw or typed HTTP errors; fixed/range/default error statuses |
| Non-JSON text bodies | Yes | Yes | No | No |
| Raw binary `bytes` bodies | Yes: `ByteArray`; client has opt-in scoped streaming download | No: generic non-JSON response reader uses text | No | No |
| `Http.File` request bodies / model-form `@multipartBody` uploads | Yes: configurable server buffering/streaming | Yes: `Blob` / `FormData` | Yes: `Blob` / `FormData` | No |
| `Http.File` / multipart responses | Yes: buffered files and typed model/tuple multipart responses | No | No | No |
| Tuple-form `@multipartBody` | Yes: named and positional tuple parts | No: shared error | No: shared error | No |
| `@useAuth` | Yes: client credentials and exact server OR-of-AND provider requirements | Partial: supported credentials and alternatives | Partial: same credentials | No: authenticated operations rejected |
| Typed SSE (`SSEStream<@events union>`) and untyped `text/event-stream` | Yes: `Flow` | Yes: `AsyncIterable` | Yes: `AsyncIterable` | No |
| JSON Lines (`JsonlStream<T>`, `application/jsonl` / `application/x-ndjson`) | Yes: request/response `Flow<T>` | No | No | No |
| Custom/raw HTTP streams (`HttpStream`, wire body `bytes` / `string`) | Opt-in: `features.raw-streams` generates request/response `Flow<ByteArray>` / `Flow<String>` chunks; application owns record framing | No | No | No |
| Additional framed protocols (e.g. JSON text sequences) | No built-in codec; Kotlin raw streams can carry their wire bytes/text | No | No | No |
| SSE-encoded request streams | No: `unsupported-request-stream` error | No | No | No |
| WebSockets | Opt-in: Ktor client/server `webSocket` metadata and scoped sessions; frame protocols are application-owned | No | No | No |
| Automatic pagination / long-running-operation polling | No generated helper | No generated helper | No generated helper | No generated helper |

Qualifications:

- Go's `unsupportedOperation` rejects unsupported operation shapes before HTTP
  generation: authentication, non-JSON bodies/streams, multiple or non-fixed success
  statuses, success response headers, cookies and unsupported parameter types.
  Server paths require whole-segment placeholders and unambiguous router patterns.
- Ktor and TS credential generation supports bearer, basic and API keys (header,
  query, cookie). OAuth2 uses a supplied bearer token; token acquisition/refresh is
  application-owned. Unsupported schemes warn and their alternatives are dropped.
  Ktor server authentication requires application-installed providers. Compound alternatives
  isolate provider evaluation; generated failures use a 401 challenge. See [authentication](authentication.md)
  for principal and challenge behavior.
- Kotlin SSE and JSON Lines retain response headers and multiple success variants through scoped
  client callbacks; simple single-success responses keep their cold `Flow` API. TypeScript SSE requires
  one success response without response headers; other shapes warn `unsupported-sse-response`
  and become text bodies. Typed SSE needs the optional TypeSpec events/streams/SSE libraries.
  No generated reconnection or Last-Event-ID handling; see [server-sent events](server-sent-events.md).
- Kotlin raw streams preserve wire bytes or incrementally decoded text. Transport chunk boundaries are
  not logical item boundaries, and the logical `HttpStream` item type does not select a custom framing codec.
  Raw request bodies must be required and can be collected once; empty flows represent empty bodies.
  Text honors the declared/request/response charset, defaulting to UTF-8. Unsupported request media types
  or charsets answer 415; malformed request text answers 400 when consumed. Declared error responses remain buffered.
- Upload support does not imply arbitrary MIME support: TS sends `FormData` as
  `multipart/form-data`, including for a declared `multipart/mixed` body. Inherited
  multipart parts and `Http.File` in JSON have additional limits; see [uploads](uploads.md).
- TS React Query hooks and Server Actions skip upload and streaming operations.
  Server Actions exist only in the grouped style. Effect client methods/Streams are
  opt-in on the client target separately from model Effect schemas; see [TypeScript](typescript.md).
- Pagination models and operations can still be emitted as ordinary models and
  methods. This does not provide automatic page traversal or polling behavior.

Implementation: [shared HTTP IR](../packages/core/src/ir/services.ts),
[Ktor client planning](../packages/kotlin-ktor-client/src/plan.ts),
[Ktor server planning](../packages/kotlin-ktor-server/src/plan.ts),
[Ktor WebSocket validation](../packages/kotlin-ktor-client/src/websocket.ts),
[TS grouped planning](../packages/ts-nextjs-client/src/plan.ts),
[TS flat validation](../packages/ts-nextjs-client/src/flat.ts) and
[Go operation validation](../packages/go/src/transform/operations.ts).
Tests: [Ktor client](../packages/kotlin-ktor-client/test/client.test.ts),
[Ktor server](../packages/kotlin-ktor-server/test/server.test.ts),
[multipart responses](../packages/kotlin-ktor-server/test/multipart-responses.test.ts),
[JSON Lines](../packages/kotlin-ktor-server/test/json-lines.test.ts),
[streaming response metadata](../packages/kotlin-ktor-server/test/streaming-responses.test.ts),
[raw stream generation](../packages/kotlin-ktor-server/test/raw-streams.test.ts),
[raw stream runtime and cancellation](../e2e/kotlin/server/src/test/kotlin/RawStreamsE2ETest.kt),
[WebSockets](../packages/kotlin-ktor-client/test/websocket.test.ts),
[TS grouped client](../packages/ts-nextjs-client/test/client.test.ts),
[TS flat client](../packages/ts-nextjs-client/test/flat.test.ts),
[TS auth runtime](../packages/ts-nextjs-client/test/auth.runtime.test.ts),
[Go client/server](../packages/go/test/emitter.test.ts) and
[Gin server](../packages/go-gin-server/test/emitter.test.ts).

## Shared metadata, versioning and extension points

| Feature | Kotlin | TypeScript | Go |
|---|---|---|---|
| `@versioned`, version selection and dependency mutation | Yes: one version per emit | Yes: one version per emit | Yes: shared version resolution |
| Generated API version constant | Yes: `features.api-version` | Yes: `features.api-version` | Yes: `features.api-version` |
| `@doc` / deprecation metadata | Yes: KDoc and `@Deprecated` on declarations, properties, enum/union wrapper members, clients and services; parameter metadata becomes `@param` KDoc; shared sealed-variant metadata is documented on the union | Partial: IR retains both; rendering depends on declaration/template | Partial: same |
| `@friendlyName` and configured naming | Yes | Yes | Yes |
| Arbitrary custom decorator semantics | No automatic behavior; captured for plugins/templates | Same | Same |
| Visibility/lifecycle-specific model projections | Opt-in: `features.lifecycle-models` creates HTTP lifecycle payload projections | No | No |
| `model-collection: reachable`, `include-services`, `include-operations`, `include-types` | Opt-in: shared selection before language transforms | Same | Same |
| `@meta`, plugins and layered template overrides | Yes: language/target-specific supported keys | Yes: language/target-specific supported keys | Yes: language/target-specific supported keys |

Versioning applies the selected version's additions/removals, renames, optionality
and type changes before targets run. It does not automatically add a version header
or query parameter. Generate multiple versions in separate emits. Shared types
needed at incompatible versions warn `version-conflict`; see [versioning](versioning.md).

Enable Kotlin `features.lifecycle-models` to generate distinct read/create/update payloads
using HTTP lifecycle visibility, including recursive and collection references. PATCH fields
follow the pinned HTTP library: explicitly declare optional properties (implicit PATCH optionality
is disabled by default in TypeSpec 1.16). The other languages retain their existing shapes. Custom decorators
are retained as metadata, not executed as new generation features. `@meta` keys are
language/target-specific, so a Kotlin customization does not imply a Go equivalent.

Implementation: [version resolution](../packages/core/src/ir/versioning.ts),
[selection](../packages/core/src/ir/selection.ts),
[docs metadata](../packages/core/src/ir/docs.ts),
[decorator collection](../packages/core/src/ir/decorators.ts) and
[pipeline](../packages/core/src/pipeline/run.ts).
Tests: [versioning IR](../packages/core/test/ir/versioning.test.ts),
[decorators](../packages/core/test/ir/decorators.test.ts),
[Kotlin metadata and exact bounds](../packages/kotlin/test/partial-support.test.ts),
[selection](../packages/kotlin/test/client-models.test.ts) and
[pipeline](../packages/core/test/pipeline/run.test.ts).
Configuration: [options](options.md), [decorators](decorators.md),
[language metadata](language-metadata.md), [customizing output](customizing-output.md).

## Maintaining this matrix

When adding a feature, update the affected model and transport rows together,
including gates, diagnostics and lossy fallbacks. Link the responsible implementation
and positive/negative tests. Shared IR support alone is insufficient evidence that
every language or HTTP target supports a feature.

The linked tests include IR assertions, emitted-source checks and generated-code
runtime tests; they are evidence of specific cases, not exhaustive conformance.
The [CI workflow](../.github/workflows/ci.yml) runs `pnpm build`, `pnpm typecheck`,
`pnpm exec vitest run` and `pnpm e2e`. The E2E suites compile/run generated Kotlin,
TypeScript and Go; see the [development prerequisites](../README.md#development).
Runtime evidence is linked to the generated-code fixtures above; the matrix does not
claim exhaustive TypeSpec conformance. No dedicated Markdown formatter or linter is configured in the root
[package scripts](../package.json).
