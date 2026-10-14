# Versioning

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
