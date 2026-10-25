# Language-specific metadata

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
`webSocket` metadata and handshake shapes are validated as hard errors.
Other built-in keys produce an `invalid-meta` warning for wrong types; unknown keys pass through untouched:

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
| `kotlin:ktor-client` | `webSocket: boolean` | GET operations, groups, namespaces | generate a scoped WebSocket session callback instead of a buffered HTTP method; see [Kotlin](kotlin.md#websocket-client-operations) |
| `kotlin:ktor-server` / `kotlin:ktor-client` | `annotations: string[]` | operations, groups | annotations on service / client methods |
| `kotlin:ktor-server` | `wrap: string[]` | namespaces, groups, operations | route-builder calls wrapped around routes, outermost first (dsl style); duplicates within one chain are dropped and shared prefixes share one block |
| `kotlin:ktor-server` | `imports: string[]` | namespaces, groups, operations | imports added to the routes file (for names used in `wrap`/`context`; a `wrap` call to `authenticate(...)` needs `io.ktor.server.auth.authenticate` here — only the `authenticate` key adds it automatically) |
| `kotlin:ktor-server` | `context: { name, type, expr, replaces? }[]` | namespaces, groups, operations | service parameters supplied by `expr` in the route handler (`call` in scope); `replaces` (string or list) hides those HTTP parameters from the service signature — never a path parameter — and the entry applies only where they all exist; names are backtick-escaped if they are Kotlin keywords, `call`/`service`/`resource` are reserved, and later entries with the same name win |
| `kotlin:ktor-server` | `routeSet: string` | namespaces, groups, operations | move routes into `fun Route.<unit><RouteSet>Routes(service)` (dsl style); with `features.module: true` the generated module mounts every route function, including per-routeSet ones; a name that isn't a valid Kotlin identifier fails the target |
| `kotlin:ktor-server` | `multipart: "buffered" \| "streaming" \| "raw"` | namespaces, groups, operations | how multipart and file bodies reach the service (see [Uploads](uploads.md)); overrides the `multipart` option |
| `kotlin:ktor-server` | `maxUploadSize: integer` | namespaces, groups, operations | largest multipart part / buffered multipart request / buffered file body in bytes (larger → 413); overrides the `max-upload-size` option |
| `kotlin:ktor-server` | `sse: "text-writer" \| "plugin"` | namespaces, groups, operations | how a server-sent event stream is written (see [Server-sent events](server-sent-events.md)); overrides the `sse` option |
| `typescript` | `readonly: boolean` | properties | `readonly` property (wins over `features.readonly`); on a model: `invalid-meta`, use `features: #{ readonly: true }` |
| `typescript` | `features: #{ readonly }` | models, namespaces | override `features.readonly` |
| `typescript` | `enumStyle: "union-const" \| "union" \| "enum" \| "const-array"` | enums, string-literal unions | override `enum-style` |
| `typescript` | `supertypes: { name, from? }[]` | models | `interface X extends A` (zod schema cast; inherited members, including `Date` fields, are not validated/decoded) |
| `typescript` | `jsdoc: string[]` | declarations, properties | extra JSDoc lines |
| `typescript` | `values: string` | enums, string-literal unions | an identifier different from the type's own name → `export const <values> = [...] as const; export type X = (typeof <values>)[number]`; otherwise ignored with an `invalid-meta` warning |
| `typescript:ts-nextjs-client` | `next: { revalidate?, tags? }` | operations, groups | default Next.js fetch options |
| `typescript:ts-nextjs-client` | `staleTime: number` | GET operations, groups | default `staleTime` in `queryOptions` |
| `kotlin` / `typescript` / `go` (or `*`) | `features: { <key>: boolean }` | namespaces, interfaces, operations, models, enums, unions, scalars | per-declaration value of a feature with an `@meta` override (`docs`, `generics`, Kotlin/Go `enum-unknown`, Go `validation`/`defaults`, TypeScript `readonly`; see [Options reference](options.md)); other keys, wrong types or disallowed places warn `invalid-meta` |

Templates read any metadata with `it.h.meta(item)` / `it.h.meta(item, "ktor-server")`; plugins use
`resolveMeta(item.meta, language, target)` from `@abhigyakrishna/tspgen-core`.
