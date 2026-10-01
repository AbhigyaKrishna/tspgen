# Go generator internals

The Go emitter uses the same IR, file planning, and layered Eta rendering pipeline as the Kotlin emitter.
TypeScript plans declarations and wire behavior; templates contain the Go source.

| Concern | Location |
| --- | --- |
| Go IR types | `src/transform/model.ts` |
| Identifier conventions | `src/naming.ts` |
| Type mappings and imports | `src/transform/type-map.ts` |
| Model and operation transforms | `src/transform/declarations.ts`, `src/transform/operations.ts` |
| Validation shapes and generic type arguments | `src/validation.ts`, `templates/go/runtime/shapes.eta` |
| Model tags and declaration planning | `src/models/declarations.ts`, `src/models-target.ts` |
| Shared requests, errors, validation, and file layout | `src/http/` |
| Server route validation and service contracts | `src/server/routes.ts`, `src/server/operations.ts` |
| Server transport APIs and file planning | `src/server/transport.ts`, `src/server/plan.ts` |
| Model and server source | `templates/go/model/`, `templates/go/server/` |
| JSON, validation, and parameter runtime | `templates/go/runtime/` |
| net/http client planning and source | `../go-nethttp-client/src/plan.ts`, `../go-nethttp-client/templates/nethttp-client/` |

For an HTTP target, reuse `httpOperationPlan` for request fields, wire types, validation calls, and declared
errors. Keep router-specific APIs in the transport description and templates. `goSourceFile` composes
template sections and sorted imports; `httpModuleFile` handles module dependencies and the relative
models directory. The pipeline resolves all includes through its template override layers and runs gofmt.

The model runtime is split into template partials but still emits one `models/runtime.go`. Grouping options
control generated files independently of the emitter's internal module structure. Public helper exports
remain available through `src/index.ts`, `src/transform.ts`, and `src/http.ts`.

From the repository root:

```sh
pnpm build
pnpm typecheck
pnpm exec vitest run packages/go/test packages/go-gin-server/test
```

The tests compile generated modules and exercise real net/http and Gin requests, including configured
generic clients, grouped contracts, validation, JSON policies, and typed errors.
