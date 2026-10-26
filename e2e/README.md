# End-to-end tests

`spec/` owns the TypeSpec contracts for all languages. Add models, operations, and
feature fixtures there. Language-specific emitter metadata and options live in
`config/`. Generation reads the shared sources directly, without copies or
forwarding entrypoints.

Each language has separate suites for the targets it supports:

| Language   | Client suite                                                                         | Server suite                           |
| ---------- | ------------------------------------------------------------------------------------ | -------------------------------------- |
| Go         | `go/client` — net/http client, models and validation                                 | `go/server` — net/http and Gin servers |
| Kotlin     | `kotlin/client` — Ktor client and models                                             | `kotlin/server` — Ktor server          |
| TypeScript | `typescript/client` — Next.js clients, models, Zod, Effect, hooks and Server Actions | No server emitter                      |

Each suite's `generated/` directory contains its emitted target code. Go and
Kotlin keep shared model output in the language's `generated/` directory. Go's
`internal/testsupport` and Kotlin's `src/testFixtures` provide HTTP services and
assertions shared by the client and server suites. Kotlin uses separate Gradle
projects with independent test tasks and reports.

## Shared features

[`spec/features.tsp`](spec/features.tsp) is generated and exercised by all three
languages. Go and Kotlin round-trip generated clients against generated servers;
TypeScript runs its generated client against a local HTTP test server.

The contract covers constrained models, enums, encoded JSON names, timestamps,
decimals, defaults, nullability, generic pages, typed errors, escaped paths,
query/header parameters, collection bodies, discriminated inheritance, scalar
unions, and additional properties. Tests follow each emitter's supported
behavior: Go and Kotlin retain additional properties, while TypeScript's current
models and Zod schemas omit them. TypeScript defaults remain schema documentation
rather than inserted values. Kotlin's scalar union uses its documented
`JsonElement` representation.

The pet-store and versioning contracts are also shared by Kotlin and TypeScript.
Other fixtures in `spec/` cover uploads, streaming, authentication, model mapping,
and target options. Import these fixtures as emitter support expands; do not
copy or independently redefine them.

`spec/package.json` declares the compiler libraries and emitters needed to compile
the central sources. Each language suite depends on that workspace package.

## Run

From the repository root:

```sh
pnpm e2e
```

After `pnpm build`, run a language with `pnpm --filter tspgen-e2e-go test`,
`pnpm --filter tspgen-e2e-kotlin test`, or
`pnpm --filter tspgen-e2e-typescript test`.

Go and Kotlin also expose `test:client` and `test:server`, including generation:

```sh
pnpm --filter tspgen-e2e-go test:client
pnpm --filter tspgen-e2e-go test:server
pnpm --filter tspgen-e2e-kotlin test:client
pnpm --filter tspgen-e2e-kotlin test:server
```

For TypeScript, `pnpm --filter tspgen-e2e-typescript test` generates and runs its
client suite. Its `test:client` command runs the already-generated code.
