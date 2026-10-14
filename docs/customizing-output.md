# Customizing output

**Template overrides.** Every file is rendered from [Eta](https://eta.js.org) templates addressed by
logical name. A file in `template-dir` with the same relative path wins over plugin, target and
language templates, so you can override one partial without forking:

| Template | Renders |
|---|---|
| `kotlin/file` | file skeleton (header, package, imports, body) |
| `kotlin/common/header` | the "generated" header comment |
| `kotlin/model/{data-class,sealed-interface,enum,typealias,value-class}` | model declarations (`value-class`: `scalar-style: value-class` scalars) |
| `kotlin/model/{events,sse-message,http-file,api-version}` | event unions, `SseMessage`, `HttpFile`, the `API_VERSION` constant |
| `kotlin/model/model-serializers` | `ModelSerializers.kt`: generated serializers (java.time, `BigDecimal`, …) and `modelSerializersModule` (0.1.x: `kotlin/model/java-time-serializers`) |
| `kotlin/api/{result,exception,api-exception}` | shared result/error types |
| `ktor-server/{service,module,support,part-class}` | server interface, module, runtime helpers (`serverJson`, parameters, uploads, events), streaming multipart part classes |
| `ktor-server/errors` | `<Service>Errors.kt`: `StatusPagesConfig.<svc>Errors()` (0.1.x rendered it in `ktor-server/module`) |
| `ktor-server/routes/{dsl,dsl-nodes,dsl-route,resources,resources-route,respond}` | routing styles and the response partial |
| `ktor-client/{client,response,api-client,support}` | client classes |
| `ts/file`, `ts/common/header`, `ts/barrel`, `ts/types` | TypeScript file skeleton, header, barrels, single-file layout |
| `ts/model/{interface,alias,enum}`, `ts/api/{errors,results}`, `ts/api-version` | TypeScript models and shared api types |
| `ts/codecs` | `dateTimeCodec` and friends (`date-type: date`) |
| `ts-nextjs/{core,group,index}` | fetch runtime and clients (grouped style) |
| `ts-nextjs/{auth,sse-runtime,without-undefined}` | partials shared by both styles: `@useAuth` credentials, event-stream decoding, `undefined`-key stripping |
| `ts-nextjs/{queries,hooks}` | TanStack Query (grouped style) |
| `ts-nextjs/{actions,action-result,server-client}` | Server Actions |
| `ts-nextjs/flat-client`, `ts-nextjs/{flat-queries,flat-hooks}` | flat style: `client.ts`, and its TanStack Query `queries.ts` / `hooks.ts` |

Templates receive the file data as `it`, emitter options as `it.ctx.options`, resolved feature values as
`it.features` (`{ [key]: boolean }` — the producing target's features layered over the language's, from
`FileSpec.features`), the banner text as `it.ctx.headerText` (already resolved from `features.header` and
`header-text`, `undefined` when the header is off — `common/header.eta` renders it with
`<% if (it.ctx?.headerText) { %><%~ it.h.lineComment(it.ctx.headerText) %><% } %>`), and helpers as `it.h`
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
  // 5. declare a feature of your own: set with features: { audited: true } in the language's features: block,
  //    read in transformIR/files/templates as it.features.audited (a duplicate-feature error if the language or
  //    another plugin already declares the key)
  features: { audited: { default: false, description: "Add @Audited to every model." } },
};
```

Use it with `routing-style: company`.
The routes template also receives `extras` (`ServerOpExtras` per operation id); render `extras[op.id].auth[0]`, when
present, as the route's `authenticate(...)` wrapper. A style that renders only the provider names in
`extras[op.id].authenticate` gets a warning `auth-wrapper-not-rendered` for routes whose wrapper needs more (a
`strategy`, `optional = true` or an `auth-providers` expression), as does overriding a built-in routes template
that renders wrappers.

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
