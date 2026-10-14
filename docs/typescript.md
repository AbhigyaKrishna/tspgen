# TypeScript / Next.js

```yaml
emit:
  - "@abhigyakrishna/tspgen-typescript"
options:
  "@abhigyakrishna/tspgen-typescript":
    import-extension: none            # none (Next.js/bundlers) | .js (Node ESM)
    layout: per-type                  # per-type (models/<Name>.ts + barrel) | single-file (types.ts, namespace banners)
    errors: typed                     # typed | thrown (no <Body>Error classes; success unions unchanged; api/errors.ts keeps HttpError)
    features:
      zod: true                       # PetSchema: z.ZodType<Pet> next to each type, constraint decorators as refinements (default false; zod ≥ 4.3)
    targets:
      - "@abhigyakrishna/tspgen-ts-nextjs-client":
          client-style: grouped       # grouped (client/…, hooks, actions) | flat (client.ts: one <Service>Client class)
          base-url-env: API_BASE_URL  # env var read by the actions' server-side client
          error-class: PetStoreError  # flat: error class name (default <Service>Error)
          error-model: ErrorResponse  # flat: model whose fields the error class exposes (optional)
          query-key-prefix: api       # React Query: first element of every generated query key (default: none)
          features:
            react-query: true         # TanStack Query keys, queryOptions and hooks (both styles, default true)
            server-actions: true      # grouped only (flat: ignored; unsupported-feature when set true)
            validate: true            # flat only: zod checks of body/query/constrained path params before fetch (needs features.zod)
            server-only: true         # grouped: import "server-only" in the Server Actions' server client
            hooks: true               # false: queries.ts only (no React context/provider/hooks)
            error-getters: true       # flat: isUnauthorized/isForbidden/isNotFound/isConflict on the error class
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
const api = createPetStoreClient({ baseUrl: process.env.API_BASE_URL!, auth: { BearerAuth: () => token() } });   // with @useAuth (see Authentication); else headers: async () => ({ authorization: … })
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

**Request options.** Every method takes a trailing `RequestOptions`: every `RequestInit` field except `method`,
`body` and `window` (`credentials`, `mode`, `keepalive`, `redirect`, `priority`, `referrerPolicy`, `integrity`,
`cache`, `signal`, …), `headers`, and Next.js `next` (`{ revalidate?, tags? }`). `init` in `ClientConfig` (flat:
`ClientOptions`) sets fetch options for every request. Precedence, lowest first: `init`, `@meta(…,
"typescript:ts-nextjs-client", #{ next })` defaults, the call's options; `next` is replaced, not merged. Headers
merge separately: the config's `headers` (static, or a sync or async function called per request), then
`@useAuth` credentials, then the call's `headers`. In the grouped client, an operation's own `@header` parameters
are applied last — after the call's `headers` — so they win on a name clash, and its `@cookie` parameters (plus
any `@useAuth` cookie credentials) are appended as a single `cookie` header, also after the call's `headers`; the
flat client has no header or cookie parameters. The client then sets `content-type` (and, for event streams,
`accept` unless a header already did).

```ts
const api = createPetStoreClient({ baseUrl: "/api", init: { credentials: "include" } });   // cookies on every call
await api.pets.list({ limit: 10 }, { cache: "no-store", keepalive: true });
```

**Middleware.** There are no generated interceptor hooks: pass a wrapping `fetch`, which sees every request and
response of both client styles.

```ts
const logging: typeof fetch = async (input, init) => {
  const started = Date.now();
  const res = await fetch(input, init);
  console.log(init?.method, String(input), res.status, `${Date.now() - started}ms`);
  return res;
};
const withTimeout = (ms: number, inner: typeof fetch = fetch): typeof fetch => (input, init) =>
  inner(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms) });
const withRetry = (attempts: number, inner: typeof fetch = fetch): typeof fetch => async (input, init) => {
  for (let i = 1; ; i++) {
    const res = await inner(input, init);
    if (res.status < 500 || i >= attempts || (init?.method ?? "GET") !== "GET") return res;   // retry GETs only
    await res.body?.cancel();   // release the discarded response's connection before retrying
  }
};
const api = createPetStoreClient({ baseUrl: "/api", fetch: withRetry(3, withTimeout(5_000, logging)) });
```

A wrapping `fetch` sees every call the same way, including `async *watch(…)` SSE stream methods: `withTimeout` above
races the *whole* request (and, for a stream, everything it will ever yield) against its timer, so a long-lived
stream gets aborted once `ms` elapses. Give stream methods a much longer or no timeout — e.g. skip `withTimeout`
when `new Headers(init?.headers).get("accept") === "text/event-stream"` — or compose it only around the
non-streaming client calls.

**`server-only`.** `client/actions/server-client.ts` (it reads `process.env.<base-url-env>`) starts with
`import "server-only";` (`features.server-only`, default true), so importing it from a Client Component fails the
Next.js build instead of throwing at call time. The `"use server"` action files don't import it — Client
Components import those on purpose. Next.js resolves `server-only` and declares its types; outside Next.js,
alias it to an empty module wherever Server Actions run (vitest:
`resolve: { alias: { "server-only": fileURLToPath(new URL("./test/server-only-stub.ts", import.meta.url)) } }` with
the stub `export {};`; jest: `moduleNameMapper`), and give a `tsc` without Next's types
`declare module "server-only";` or `"types": ["next"]`.

**Hooks and query keys.** `features.hooks: false` drops `hooks.ts` (context, provider, `use<Service>Client`,
query and mutation hooks) in both styles and keeps the server-safe `queries.ts`, for apps that provide the client
themselves: `useQuery(petStoreQueries.pets.get(api, { petId: 1 }))`. `query-key-prefix: api` makes `"api"` the
first element of every generated key (`["api", "PetStore", "pets", "get", params]`, `all` keys included), so
`invalidateQueries({ queryKey: ["api"] })` covers every generated query and two generated clients sharing a
`QueryClient` don't collide.

The fetch client throws `HttpError` subclasses (`NotFoundError` has a typed `.error`). An
`application/problem+json` response (the Ktor server's own 4xx/5xx) is never decoded as a declared error model: it
throws a plain `HttpError` whose `body` is the problem and whose message is its `detail` (else `title`). With zod on,
responses are validated (`validate: false` in `ClientConfig` turns it off) and Server Action input is
checked first (`{ ok: false, status: 400, error: { issues } }`; not affected by `validate: false`). Direct
`<Group>Client` calls don't check their params. Property names match the JSON wire names; dates are ISO
strings (`Date`s decoded by zod codecs with `date-type: date`).

**Constraints in zod.** With `features.zod`, TypeSpec constraint decorators on model properties and operation
parameters become refinements on the generated schemas: `@minLength`/`@maxLength` → `.min(n)`/`.max(n)` on
strings, `@pattern` → `.regex(new RegExp("…", "u"))`, `@minItems`/`@maxItems` → `.min`/`.max` on arrays,
`@minValue`/`@maxValue` → `.gte`/`.lte` on numbers, and `notBlank: true` in meta scope `*` or `typescript` →
`.regex(/\S/, "must not be blank")`. Constraints that don't fit the property's type are ignored, and a
property with a `@TS.type` override gets none. Optional properties use zod's `.exactOptional()` instead of
`.optional()`, so schemas type-check under `exactOptionalPropertyTypes`; when parsing responses or models,
an optional key present with value `undefined` (e.g. `{ note: undefined }`) fails — omit the key instead.
Request checks (Server Action input, flat `features.validate` bodies) drop `undefined`-valued keys first, as JSON
does when sending. Not applied: numeric bounds (`@minValue`/`@maxValue`) on `decimal`/`decimal128` (zod
strings, so string constraints such as `@pattern` do apply), `@minValueExclusive`/`@maxValueExclusive`, and
scalar-level constraints on array items (`Slug[]`); `notBlank` applies to model properties only. `@pattern`
is compiled with the `u` flag when valid there (else without flags), and a pattern JavaScript can't parse is
skipped with an `invalid-pattern` warning.

**Flat client** (`client-style: flat`) — one class per service, for projects that want a thin typed `fetch`
wrapper instead of the grouped client/hooks/actions tree:

```
types.ts / models/…   models (per layout)
client.ts             ClientOptions, <error-class> (default <Service>Error), <Service>Client (one method per operation)
index.ts              export * from ./types (or ./models/index), ./client (and ./queries unless features.react-query is false)
queries.ts            features.react-query only — <Op>Vars, <service>Keys, <service>Queries (server-safe)
hooks.ts              features.react-query only — "use client": <Service>ClientProvider, use<Service>Client,
                      use<Op>Query / use<Op>Mutation (not re-exported from index.ts; import from ./hooks)
```

```ts
const api = new ShopClient({ baseUrl: "/api", headers: async () => ({ authorization: await token() }) });   // or a plain object
const page = await api.listNodes({ kind: "DATABASE", limit: 10 });   // path params, then body, then a query object
try { await api.readNode(id); } catch (e) { if (e instanceof ShopError && e.isNotFound) … }
await api.readNode(id, { signal: controller.signal, cache: "no-store" });   // optional trailing RequestOptions
```

Methods are named after operations (names must be unique across the service) and take path parameters
positionally, then the body, then a query object (named `query`, or `queryParams`/`params` if that name is
already taken), then an optional `init?: RequestOptions` passed to `fetch` (see Request options; `@meta` `next`
defaults apply as in the grouped client), named `init`, or `requestInit`/`options`/`init2`… if a parameter
already uses the name; array query values are comma-joined into one value unless the param has `explode: true`, in
which case the key repeats. A path parameter or body named like a reserved word (`class`, `default`, …) is
renamed inside the method (`classValue`); parameters are positional, so callers are unaffected. Void operations don't read the response body; others decode an empty body as
`undefined`. `<error-class>` exposes `status`, `body` (the `error-model`, decoded only when the JSON error body
has all of that model's required fields, else `undefined`; without `error-model` it's the raw decoded body),
the model's other identifier-named fields (nullable types kept as-is), `problem` (an `application/problem+json`
body, which is never the `error-model`: `body` stays `undefined` and the message is the problem's `detail`, else
`title`), and
`isUnauthorized`/`isForbidden`/`isNotFound`/`isConflict` (`features.error-getters: false` leaves the getters out; the grouped style has typed error classes instead).

The flat client does not validate responses. With `features.validate` (on by default; effective only with `features.zod` on the
`@abhigyakrishna/tspgen-typescript` options), each method checks its body (skipped when an optional body is
`undefined`; `undefined`-valued keys are ignored), its query object, and any path parameters that carry
constraints against the generated zod schemas before calling `fetch`; on failure the returned promise
rejects with zod's `ZodError` — not `<error-class>` — and the original value is still sent, not zod's
parsed copy. A path parameter or body named `z` is renamed inside the method so it does not shadow the zod
import (parameters are positional, so callers are unaffected), and a generated type named `z` is reported as
a name clash. The grouped client style validates responses and Server Action input (not direct
`<Group>Client` calls) on its own; setting `features.validate: true` there has no effect and warns (`unsupported-feature`).
The flat client also ignores `errors: typed` for its own error handling: `<error-class>` is always the flat client's single thrown error type, so the
`api/` `<Body>Error` classes are still generated but go unused; set `errors: thrown` to skip generating them.

**Flat client + TanStack Query** (`features.react-query`, on by default):

```ts
// queries.ts (server-safe, re-exported from index.ts) — prefetch on the server
await queryClient.prefetchQuery(shopQueries.nodes.readNode(api, { id }));

// app/providers.tsx — a class instance can't cross from a Server Component, so create the client here, once
"use client";
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  // with @useAuth, credentials are configured here too: { baseUrl: "/api", auth: { BearerAuth: () => getToken() } }
  const [api] = useState(() => new ShopClient({ baseUrl: "/api" }));
  return (
    <QueryClientProvider client={queryClient}>
      <ShopClientProvider client={api}>{children}</ShopClientProvider>
    </QueryClientProvider>
  );
}

// Client Components (hooks from ./hooks, "use client") — every hook takes one <Op>Vars object
const { data } = useReadNodeQuery({ id });
const nodes = useListNodesQuery({ query: { kind: "DATABASE" } }, { staleTime: 5_000 });
const update = useUpdateNodeMutation({ onSuccess: () => queryClient.invalidateQueries({ queryKey: shopKeys.nodes.all }) });
update.mutate({ id, body: { name: "db" }, query: { dryRun: true } });
```

`<Op>Vars` (for operations with inputs) holds the path parameters under the generated parameter names
(camelCased, e.g. `@path node_id` → `nodeId`; a parameter renamed inside the method — `z` with `features.validate`, a
reserved word such as `class` — keeps that name here), `body` (optional when the body is; documented with the
body parameter's doc comment), and `query` (the method's query object; optional unless a query parameter is
required); operations without inputs get no Vars type and their hooks take none (`useRefreshMutation()`,
variables `void`). A void GET/HEAD query resolves `null` (TanStack Query rejects `undefined` data), so its data
type is `null`; the grouped client's void queries do the same. Keys and query options of deprecated
operations are marked `@deprecated`, like their hooks. Keys are
`<service>Keys.all` (`[Service]`), `<service>Keys.<group>.all` (`[Service, group]`) and, per GET/HEAD
operation, `<service>Keys.<group>.<op>(vars)` (`[Service, group, op, vars]`); `<service>Queries.<group>.<op>(client,
vars)` returns `queryOptions` whose `queryFn` passes TanStack's `signal` to the method (cancelled queries abort
the fetch) and applies `staleTime` from `@meta(…, "typescript:ts-nextjs-client", #{ staleTime })`. GET/HEAD
operations get `use<Op>Query(vars, options?)`; all others, uploads included, get `use<Op>Mutation(options?)`
whose `mutate` takes the Vars object (mutations are not cancellable). `use<Service>Client()` throws outside
`<Service>ClientProvider`. With `features.hooks: false` only `queries.ts` is generated, and the provider, context
and hook names are free for generated types. Hooks and query options call the provided client's methods, so `@useAuth` credentials
(the client's `auth` option) and the query's `signal` both reach `fetch`. An operation with a path parameter named `body` (and a body) or `query` (and query
parameters), which would collide with those Vars keys, gets no hooks, keys or Vars — only its client method —
with a `flat-react-query-skipped` warning. With `features.react-query` the flat style also reports a hook, Vars type or query key generated twice — the same operation name in two services, a query operation
named `all`, a group named `All` (`flat-react-query-name-clash`); and generated types named like the new
exports or like the TanStack Query / React names the two files use (`queryOptions`, `useQuery`,
`useMutation`, `UseQueryOptions`, `UseMutationOptions`, `createContext`, `createElement`, `useContext`,
`ReactNode`, `Omit`, `ReturnType`, `<Service>ClientContext`) (`flat-client-name-clash`).

React Query hooks and Server Actions are on by default (`features.react-query`, `features.server-actions`);
Server Actions exist only in the grouped style: under `client-style: flat`, `features.server-actions: true` is
ignored with an `unsupported-feature` warning. The flat style also
rejects, per operation, several success responses or response headers, header/cookie parameters, non-JSON
bodies other than multipart and file uploads, non-JSON responses, optional path parameters, and operation
names that clash with client members (`flat-client-unsupported`); rejects duplicate operation names
(`duplicate-operation-name`); rejects an `error-model` that isn't a generated model (`unknown-error-model`);
and rejects a generated type named like the error class, `ClientOptions`, `RequestOptions`, `RequestDefaults`,
`NextFetchOptions`, `HeadersInput`, `<Service>Client` or, with `@useAuth`,
`<Service>Auth` (`flat-client-name-clash`, since `index.ts` re-exports both), or like a name `client.ts` uses
internally — a global such as `Response`, `Promise`, `RequestInit`, `Omit` or `AbortSignal`, with uploads `BodyInit`,
`RawBody`, `PartSpec` or `toFormData`, with `@useAuth` `AuthScheme`, `AuthEntries`, `resolveAuth` or `base64`, with
server-sent event streams `EventSpec`, `RawEvent`, `readEvents`, `decodeEvents`, `decodeData`, `MAX_SSE_SIZE`,
`AsyncGenerator`, `AsyncIterable`, `ReadableStream`, `TextDecoder` or `Uint8Array`, with `features.validate` zod's `z` (same
code, its own message) — rename it with `@TS.name`. With `@useAuth`, an operation named `auth` clashes with a client
member. `Headers`, `Blob`, `File` and `FormData` are read through `globalThis`, so models may use those names.
Server-sent event streams are the one non-JSON response the flat style accepts (see [Server-sent events](server-sent-events.md)).
