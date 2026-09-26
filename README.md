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

## Usage

```bash
npm install -D @typespec/compiler @typespec/http @abhigyakrishna/tspgen-kotlin \
  @abhigyakrishna/tspgen-kotlin-ktor-server @abhigyakrishna/tspgen-kotlin-ktor-client
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
    validation: false                   # true: @minLength/@maxLength/@pattern/@minItems/@maxItems/@minValue/@maxValue → init { require(...) }
    targets:
      - "@abhigyakrishna/tspgen-kotlin-ktor-server":
          routing-style: dsl            # dsl | resources | <plugin-registered>
          grouping: per-interface       # per-interface | per-namespace | single-file
          handler-shape: params         # params | request-object
          call-access: false            # pass ApplicationCall to handlers
          service-suffix: Service       # interface name suffix, e.g. Api → PetsApi
          module: true                  # false: no <Service>Module.kt (you install ContentNegotiation/StatusPages, and Resources if routing-style: resources)
          nest-routes: false            # true: route("/common/prefix") { get { } get("/{id}") { } } (dsl style)
      - "@abhigyakrishna/tspgen-kotlin-ktor-client": {}
    naming:
      enum-members: UPPER_SNAKE         # UPPER_SNAKE | PascalCase
    template-dir: ./tspgen-templates   # optional template overrides
    plugins: [./tspgen/audit.js]       # optional plugins, applied in order
```

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
  - "@abhigyakrishna/tspgen-typescript"
options:
  "@abhigyakrishna/tspgen-typescript":
    zod: true                         # emit PetSchema: z.ZodType<Pet> next to each type (default false)
    import-extension: none            # none (Next.js/bundlers) | .js (Node ESM)
    layout: per-type                  # per-type (models/<Name>.ts + barrel) | single-file (types.ts, namespace banners)
    errors: typed                     # typed | thrown (no <Body>Error classes; success unions unchanged; api/errors.ts keeps HttpError)
    targets:
      - "@abhigyakrishna/tspgen-ts-nextjs-client":
          client-style: grouped       # grouped (client/…, hooks, actions) | flat (client.ts: one <Service>Client class)
          react-query: true           # grouped only; no schema default — unset behaves as true (flat: error if set true)
          server-actions: true        # grouped only; no schema default — unset behaves as true (flat: error if set true)
          base-url-env: API_BASE_URL  # env var read by the actions' server-side client
          error-class: ApiError       # flat: error class name
          error-model: ErrorResponse  # flat: model whose fields the error class exposes (optional)
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

**Flat client** (`client-style: flat`) — one class per service, for projects that want a thin typed `fetch`
wrapper instead of the grouped client/hooks/actions tree:

```
types.ts / models/…   models (per layout)
client.ts             ClientOptions, <error-class>, <Service>Client (one method per operation)
index.ts              export * from ./types (or ./models/index) and ./client
```

```ts
const api = new ShopClient({ baseUrl: "/api", headers: { authorization: token } });
const page = await api.listNodes({ kind: "DATABASE", limit: 10 });   // path params, then body, then a query object
try { await api.readNode(id); } catch (e) { if (e instanceof ApiError && e.isNotFound) … }
```

Methods are named after operations (names must be unique across the service) and take path parameters
positionally, then the body, then a query object (named `query`, or `queryParams`/`params` if that name is
already taken); array query values are comma-joined into one value unless the param has `explode: true`, in
which case the key repeats. Void operations don't read the response body; others decode an empty body as
`undefined`. `<error-class>` exposes `status`, `body` (the `error-model`, decoded only when the JSON error body
has all of that model's required fields, else `undefined`; without `error-model` it's the raw decoded body),
the model's other identifier-named fields (nullable types kept as-is), and
`isUnauthorized`/`isForbidden`/`isNotFound`/`isConflict`.

The flat client does not validate responses with zod, even with `zod: true` on the `@abhigyakrishna/tspgen-typescript`
options — that option only adds `<Type>Schema` exports alongside the models. It also ignores `errors: typed`
for its own error handling: `<error-class>` is always the flat client's single thrown error type, so the
`api/` `<Body>Error` classes are still generated but go unused; set `errors: thrown` to skip generating them.

React Query hooks and Server Actions have no schema default: unset, the grouped client treats them as on; under
`client-style: flat` setting either to `true` is an error (`unsupported-in-flat-style`). The flat style also
rejects, per operation, several success responses or response headers, header/cookie parameters, non-JSON
bodies or responses, optional path parameters, and operation names that clash with client members
(`flat-client-unsupported`); rejects duplicate operation names (`duplicate-operation-name`); rejects an
`error-model` that isn't a generated model (`unknown-error-model`); and rejects a generated type named like
the error class, `ClientOptions`, or `<Service>Client` (`flat-client-name-clash`, since `index.ts` re-exports
both) — rename it with `@TS.name`.

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
@meta("typescript", #{ readonly: true })
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
Operations inherit metadata from enclosing namespaces (outermost first), then their interface. `wrap`, `routeSet`
and `nest-routes` require `routing-style: dsl`; with any other style the target fails rather than dropping guards.
Built-in keys (wrong types produce an `invalid-meta` warning; unknown keys pass through untouched):

| Scope | Key | On | Effect |
|---|---|---|---|
| `kotlin` | `annotations: string[]` | types, properties, enum members, operations | annotation lines |
| `kotlin` | `imports: string[]` | types | extra imports |
| `kotlin` | `implements: string[]` | models, sealed hierarchies | extra supertypes (FQN; qualified automatically on name clashes) |
| `kotlin` | `checks: string[]` | models | statements appended to the data class `init { }` block (`init` is reserved in TypeSpec) |
| `kotlin:ktor-server` | `authenticate: string \| string[]` | operations, groups | route wrapped in `authenticate(...) { }` (install Ktor `Authentication`) |
| `kotlin:ktor-server` / `kotlin:ktor-client` | `annotations: string[]` | operations, groups | annotations on service / client methods |
| `kotlin:ktor-server` | `wrap: string[]` | namespaces, groups, operations | route-builder calls wrapped around routes, outermost first (dsl style); duplicates within one chain are dropped and shared prefixes share one block |
| `kotlin:ktor-server` | `imports: string[]` | namespaces, groups, operations | imports added to the routes file (for names used in `wrap`/`context`; a `wrap` call to `authenticate(...)` needs `io.ktor.server.auth.authenticate` here — only the `authenticate` key adds it automatically) |
| `kotlin:ktor-server` | `context: { name, type, expr, replaces? }[]` | namespaces, groups, operations | service parameters supplied by `expr` in the route handler (`call` in scope); `replaces` (string or list) hides those HTTP parameters from the service signature — never a path parameter — and the entry applies only where they all exist; names are backtick-escaped if they are Kotlin keywords, `call`/`service`/`resource` are reserved, and later entries with the same name win |
| `kotlin:ktor-server` | `routeSet: string` | namespaces, groups, operations | move routes into `fun Route.<unit><RouteSet>Routes(service)` (dsl style); with `module: true` the generated module mounts every route function, including per-routeSet ones; a name that isn't a valid Kotlin identifier fails the target |
| `typescript` | `readonly: boolean` | models, properties | `readonly` properties |
| `typescript` | `supertypes: { name, from? }[]` | models | `interface X extends A` (zod schema cast; inherited members not validated) |
| `typescript` | `jsdoc: string[]` | declarations, properties | extra JSDoc lines |
| `typescript` | `values: string` | enums, string-literal unions | an identifier different from the type's own name → `export const <values> = [...] as const; export type X = (typeof <values>)[number]`; otherwise ignored with an `invalid-meta` warning |
| `typescript:ts-nextjs-client` | `next: { revalidate?, tags? }` | operations, groups | default Next.js fetch options |
| `typescript:ts-nextjs-client` | `staleTime: number` | GET operations, groups | default `staleTime` in `queryOptions` |

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
};
```

Use it with `routing-style: company`.

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

## License

[MIT](LICENSE)
