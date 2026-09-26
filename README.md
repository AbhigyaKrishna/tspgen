# specgen — multi-language SDK emitters for TypeSpec

Generate models, server stubs and typed clients from one [TypeSpec](https://typespec.io) definition.
The core is language-neutral; languages and server/client libraries plug in as separate packages.

| Package | Role |
|---|---|
| `@specgen/emitter-core` | TypeSpec → language-neutral IR, layered Eta templates, plugin API, pipeline, output manifest |
| `@specgen/emitter-kotlin` | The TypeSpec emitter for Kotlin: kotlinx.serialization models, result/error types, `@Kotlin.*` decorators |
| `@specgen/kotlin-ktor-server` | Target: Ktor server — service interfaces, routing, module with JSON + StatusPages |
| `@specgen/kotlin-ktor-client` | Target: Ktor `HttpClient` SDK |
| `@specgen/emitter-typescript` | The TypeSpec emitter for TypeScript: interfaces, literal-union enums, optional zod schemas, result/error types, `@TS.*` decorators |
| `@specgen/ts-nextjs-client` | Target: Next.js client SDK — typed `fetch` client, TanStack Query hooks, Server Actions |

## Usage

```bash
npm install -D @typespec/compiler @typespec/http @specgen/emitter-kotlin \
  @specgen/kotlin-ktor-server @specgen/kotlin-ktor-client
```

`tspconfig.yaml`:

```yaml
emit:
  - "@specgen/emitter-kotlin"
options:
  "@specgen/emitter-kotlin":
    package: "com.acme.pets"            # base package (default "generated")
    targets:
      - "@specgen/kotlin-ktor-server":
          routing-style: dsl            # dsl | resources | <plugin-registered>
          grouping: per-interface       # per-interface | per-namespace | single-file
          handler-shape: params         # params | request-object
          call-access: false            # pass ApplicationCall to handlers
      - "@specgen/kotlin-ktor-client": {}
    naming:
      enum-members: UPPER_SNAKE         # UPPER_SNAKE | PascalCase
    template-dir: ./specgen-templates   # optional template overrides
    plugins: [./specgen/audit.js]       # optional plugins, applied in order
```

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

### Server

```kotlin
fun Application.module() = petStoreModule(MyPetsService())   // installs JSON, StatusPages, routing
```

Or compose it yourself: `routing { petStoreApiRoutes(pets) }` and `install(StatusPages) { petStoreErrors() }`.
Throw a generated `…Exception` (e.g. `NotFoundException(NotFound("…"))`) to send a typed error response.

### Client

```kotlin
val http = HttpClient(CIO) { petStoreDefaults() }             // JSON content negotiation
val api = PetStoreApiClient(http, "https://api.example.com")
val pet = api.pets.get(petId = 1)                             // typed errors are thrown as …Exception
```

Authentication is configured on your `HttpClient` (Ktor `Auth` plugin or `defaultRequest`).

## TypeScript / Next.js

```yaml
emit:
  - "@specgen/emitter-typescript"
options:
  "@specgen/emitter-typescript":
    zod: true                         # emit PetSchema: z.ZodType<Pet> next to each type (default false)
    import-extension: none            # none (Next.js/bundlers) | .js (Node ESM)
    targets:
      - "@specgen/ts-nextjs-client":
          react-query: true           # keys, queryOptions and hooks (default true)
          server-actions: true        # "use server" actions for non-GET operations (default true)
          base-url-env: API_BASE_URL  # env var read by the actions' server-side client
```

Output: `models/` (one file per type + `index.ts`), `api/` (`HttpError` + typed `<Body>Error` classes,
multi-status result unions), and `client/`:

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
const api = createPetStoreClient({ baseUrl: process.env.API_BASE_URL!, headers: async () => ({ authorization: await token() }) });
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

The fetch client throws `HttpError` subclasses (`NotFoundError` has a typed `.error`); with zod on,
responses are validated (`validate: false` in `ClientConfig` turns it off) and Server Action input is
checked first (`{ ok: false, status: 400, error: { issues } }`). Property names match the JSON wire
names; dates are ISO strings.

## Decorators

```tsp
import "@specgen/emitter-kotlin";

@Kotlin.name("Customer")                 // rename the generated declaration/property/operation
@Kotlin.annotate("@Suppress(\"unused\")") // add annotations (repeatable)
model User {
  @Kotlin.type("java.util.UUID") id: string;   // map to any Kotlin type (import added)
}

@Kotlin.packageName("com.acme.shared")    // place a model/enum/union in another package
model Money { amount: string }
```

TypeScript: `@TS.name("Customer")` renames a generated type; `@TS.type("Decimal", "decimal.js")` maps a
model, scalar, enum, union or property to an external type (module optional, e.g. `@TS.type("Date")`).

## Customizing output

**Template overrides.** Every file is rendered from [Eta](https://eta.js.org) templates addressed by
logical name. A file in `template-dir` with the same relative path wins over plugin, target and
language templates, so you can override one partial without forking:

| Template | Renders |
|---|---|
| `kotlin/file` | file skeleton (header, package, imports, body) |
| `kotlin/common/header` | the "generated" header comment |
| `kotlin/model/{data-class,sealed-interface,enum,typealias}` | model declarations |
| `kotlin/api/{result,exception,api-exception}` | shared result/error types |
| `ktor-server/{service,module,support}` | server interface, module, parameter helpers |
| `ktor-server/routes/{dsl,resources,respond}` | routing styles and the response partial |
| `ktor-client/{client,response,api-client,support}` | client classes |
| `ts/file`, `ts/common/header`, `ts/barrel` | TypeScript file skeleton, header, barrels |
| `ts/model/{interface,alias,enum}`, `ts/api/{errors,results}` | TypeScript models and shared api types |
| `ts-nextjs/{core,group,index}` | fetch runtime and clients |
| `ts-nextjs/{queries,hooks}` | TanStack Query |
| `ts-nextjs/{actions,action-result,server-client}` | Server Actions |

Templates receive the file data as `it`, emitter options as `it.ctx.options`, and helpers as `it.h`
(`it.h.kdoc`, `it.h.str`, `it.h.ktorServer.*`, `it.h.ktorClient.*`, plus plugin helpers).

**Plugins.** A plugin is a module whose default export is a `SpecgenPlugin`:

```js
// specgen/audit.js
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
};
```

Use it with `routing-style: company`.

## Adding a language or library

- **New server/client library for an existing language:** publish a package whose default export is a
  `Target<KotlinIR>` (`name`, `kind`, `language: "kotlin"`, `templates`, `helpers`, `optionsSchema`,
  `files(ir, ctx)`), then list it under `targets`. See `packages/kotlin-ktor-client` for a compact example.
- **New language:** create an emitter package with a `LanguageModule` (`transform(apiIR) → YourIR`,
  base `templates`, `helpers`, optional `format`) and a built-in models target, and call `runPipeline`
  from `$onEmit`. Core (IR, plugins, templates, targets, manifest) is reused unchanged.

## Development

```bash
pnpm install
pnpm test        # build all packages, run unit + emitter tests (vitest)
pnpm e2e         # Kotlin: Gradle build + client↔server test; TypeScript: tsc --strict + stub-server tests
```

The e2e build needs JDK 17+. If Gradle cannot download over IPv6 on your network, run
`JAVA_TOOL_OPTIONS=-Djava.net.preferIPv4Stack=true pnpm e2e`.

Design and plans live in `docs/superpowers/`.
