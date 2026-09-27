# Changelog

All packages (`@abhigyakrishna/tspgen-core`, `-kotlin`, `-kotlin-ktor-server`, `-kotlin-ktor-client`,
`-typescript`, `-ts-nextjs-client`) are released together with the same version.

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
