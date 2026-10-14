# Type mapping

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
