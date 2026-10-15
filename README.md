# tspgen — multi-language SDK emitters for TypeSpec

Generate models, server stubs and typed clients from one [TypeSpec](https://typespec.io) definition.
The core is language-neutral; languages and server/client libraries plug in as separate packages.

| Package | Role |
|---|---|
| `@abhigyakrishna/tspgen-core` | TypeSpec → language-neutral IR, layered Eta templates, plugin API, pipeline, output manifest |
| `@abhigyakrishna/tspgen-kotlin` | The TypeSpec emitter for Kotlin: kotlinx.serialization models, result/error types, `@Kotlin.*` decorators |
| `@abhigyakrishna/tspgen-kotlin-ktor-server` | Target: Ktor server — service interfaces, routing, module with JSON + StatusPages |
| `@abhigyakrishna/tspgen-kotlin-ktor-client` | Target: Ktor `HttpClient` SDK |
| `@abhigyakrishna/tspgen-typescript` | The TypeSpec emitter for TypeScript: interfaces, literal-union enums, optional Zod and Effect schemas, result/error types, `@TS.*` decorators |
| `@abhigyakrishna/tspgen-ts-nextjs-client` | Target: Next.js client SDK — typed `fetch` client, optional Effect client, TanStack Query hooks, Server Actions |
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

## Documentation

| Guide | Contents |
|---|---|
| [Kotlin](docs/kotlin.md) | `tspconfig.yaml`, packages, output layout, generics, date/time, sealed unions, Ktor server and client |
| [TypeScript / Next.js](docs/typescript.md) | Models, zod schemas, grouped and flat Next.js clients, TanStack Query, Server Actions |
| [Go](docs/go.md) | Models, `net/http` client and server, Gin server |
| [Options reference](docs/options.md) | Every emitter and target option, with kinds and defaults |
| [Uploads](docs/uploads.md) | Multipart and file bodies |
| [Authentication](docs/authentication.md) | `@useAuth` |
| [Versioning](docs/versioning.md) | `@versioned` services |
| [Server-sent events](docs/server-sent-events.md) | `text/event-stream` responses and `@events` unions |
| [Type mapping](docs/type-mapping.md) | TypeSpec → Kotlin / TypeScript / Go types |
| [Decorators](docs/decorators.md) | `@Kotlin.*` and `@TS.*` decorators |
| [Language-specific metadata](docs/language-metadata.md) | `@meta` |
| [Customizing output](docs/customizing-output.md) | Templates, plugins, naming |
| [Adding a language or library](docs/extending.md) | Writing targets and language emitters |
| [Upgrading](docs/upgrading.md) | Breaking changes from 0.1.x |

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
