# Authentication (`@useAuth`)

```tsp
@service @useAuth(BearerAuth) namespace PetStore;
model PartnerKey is ApiKeyAuth<ApiKeyLocation.header, "X-Partner">;

@route("/pets") interface Pets {
  @get list(): Pet[];                                          // BearerAuth (service level)
  @get @route("/public") @useAuth(NoAuth) featured(): Pet[];   // public
  @get @route("/mine") @useAuth(BearerAuth | NoAuth) mine(): Pet[];   // optional
  @delete @useAuth(BearerAuth | PartnerKey) remove(@path petId: int64): void;
  @post @useAuth([BearerAuth, PartnerKey]) import(@body pets: Pet[]): void;   // both
}
```

`@useAuth` on the service namespace, an enclosing namespace, an interface or an operation applies; the nearest
one wins (`NoAuth` included). Scheme ids are the scheme models' names (`BearerAuth`, `PartnerKey`); a different
scheme reusing an id (two inline `ApiKeyAuth<…>` instances) gets `_` appended, as in TypeSpec's OpenAPI output.
APIs without `@useAuth` generate exactly what they did before.

**Ktor server.** Each route is wrapped in `authenticate(...)` naming one provider per scheme — the scheme id as a
string (`authenticate("BearerAuth")`), or the Kotlin expression mapped in `auth-providers`
(`{ BearerAuth: JWT_AUTH }` → `authenticate(JWT_AUTH)`; the expression must resolve in the routes file: use a
fully qualified name or add its import with the `imports` meta key; a blank one is an error, and a key naming no
scheme id warns `unknown-auth-provider` — mind the `_` of renamed ids). Install Ktor `Authentication` with
providers of those names. Routes with the same wrapper share one block.

| `@useAuth` | Generated wrapper |
|---|---|
| `A` / `A \| B` | `authenticate(pA)` / `authenticate(pA, pB)` (the first valid credential wins; the others aren't checked) |
| `[A, B]` (A & B) | `authenticate(pA, pB, strategy = AuthenticationStrategy.Required)` |
| `A \| B \| NoAuth` | `authenticate(pA, pB, optional = true)`: anonymous calls pass; otherwise the first valid credential wins |
| `[A, B] \| NoAuth` | generated combination provider: anonymous calls pass, supplied credentials must satisfy the complete AND clause |
| `NoAuth` only, or none | none |
| `[A, B] \| C` | generated combination provider: both A and B, or C; partial AND success cannot authorize a call |

Nested `authenticate` blocks are not used for `A & B`: Ktor collects the providers of nested blocks into one
set, each with its block's strategy, so two default (first-successful) blocks accept either credential. For the
same reason, don't combine `@useAuth` with a `wrap` that calls `authenticate(...)` (the house-style pattern):
the route would accept either provider — use the `authenticate` meta key or `features.auth: false` instead. The `authenticate` meta key on an operation
or group replaces the generated wrapper; `wrap` wrappers go inside it. An `authenticate` key inherited from a namespace or
group replaces the wrapper of an operation with its own `@useAuth` too, so it can loosen (or tighten) that
operation's auth. `features.auth: false` turns generation off. The Ktor client generates credentials from
`@useAuth`, see below.

Compound requirements target Ktor 3.6 and generate `AuthenticationSupport.kt` and register synthetic providers after your
providers have been installed. Each delegate is evaluated in an isolated `AuthenticationContext` and
`skipWhen` is honored. One principal per accepted provider is copied to the call under that provider's
configured name. Ktor does not expose public enumeration of a provider's principals or native challenges;
providers producing several principals should use an application-owned wrapper. Failed compound
requirements use a generated 401 challenge rather than replaying native provider challenge bodies.
Registration is idempotent and missing providers fail at route installation.

**Next.js clients.** A service using schemes the client can send gets a `<Service>Auth` type of credential
providers, keyed by scheme id (quoted when not an identifier), passed as `auth` in the grouped client's
`ClientConfig` (`createPetStoreClient({ baseUrl, auth })`, `configurePetStoreActions({ auth })`) or the flat
client's `ClientOptions` (`new PetStoreClient({ baseUrl, auth })`):

```ts
const api = createPetStoreClient({
  baseUrl: process.env.API_BASE_URL!,
  auth: {
    BearerAuth: async () => (await cookies()).get("token")?.value,   // string | undefined, sync or async
    PartnerKey: () => process.env.PARTNER_KEY,
    // BasicAuth: () => ({ username, password }),
  },
});
```

| Scheme | Provider returns | Sent as |
|---|---|---|
| http `Bearer`, `OAuth2Auth`, `OpenIdConnectAuth` (tokens only, no flows) | `string` | `Authorization: Bearer <token>` |
| http `Basic` | `{ username, password }` | `Authorization: Basic <base64 of UTF-8 username:password>` |
| `ApiKeyAuth` | `string` | the named header, query parameter (replacing a same-named one) or cookie (joined with the operation's cookie parameters and a configured `cookie` header; **server-side only**, see below) |

A provider returning `undefined`, `null` or `""` supplies no credential.

**Cookie API keys only work server-side.** `Cookie` is a forbidden request header: browsers silently drop it from
`fetch`, so an `ApiKeyAuth` in a cookie is only sent from server code (Server Components, Route Handlers, Server
Actions, plain Node). In the browser, rely on the browser's own cookies instead: same-origin requests carry them,
cross-origin ones need a custom `fetch` with `credentials: "include"` (and a CORS setup allowing credentials):

```ts
const api = createPetStoreClient({ baseUrl: "/api", fetch: (input, init) => fetch(input, { ...init, credentials: "include" }) });
```

Each operation carries its alternatives (`auth: [[{ id: "BearerAuth", kind: "bearer" }], …]` in the request
spec); per request the client sends the first alternative whose providers all return a value (each provider is
called at most once per request). When none does, or the operation is `NoAuth` only, no credentials are added
and the server decides (an optional operation, `A | NoAuth`, still sends `A` when available). Credentials override
the configured `headers` (so they win over a configured `Authorization`); per-call `RequestOptions.headers` (both
clients) and header parameters (grouped client) override credentials in turn — unlike the Ktor client, where a
credential wins over a header parameter of the same name. Uploads, React Query hooks and
Server Actions go through the same client. Other http schemes (e.g. `Digest`) warn `unsupported-auth-scheme`;
alternatives needing them are dropped. An alternative sending two credentials as the same header (compared
case-insensitively: `[BearerAuth, BasicAuth]`, or a bearer token with an API key header named `Authorization`)
warns `auth-header-conflict`, naming the operation and header; only the last credential is sent. An API key sent
in the query under the name of one of the operation's query parameters replaces that parameter's value and warns
`auth-header-conflict` too. The warning is core's (`@abhigyakrishna/tspgen-core/auth-header-conflict`, the same for
both clients) and targets the operation, so `#suppress` on it silences it.

`ClientConfig` and `ClientOptions` default to an untyped `auth` (`object`): a service without schemes the client
can send, and group classes constructed directly (`new PetsClient(config)`), accept any `auth`, which then has no
effect. React Query keys don't include the caller's identity, so clear the `QueryClient` (`queryClient.clear()`)
on login and logout to avoid serving one user's cached data to the next. Path parameters are escaped with
`encodeURIComponent`, which leaves `.` and `..` as they are; URL parsing then resolves such a segment as a dot
segment (`/pets/..` → `/`), so validate path values that may be `.` or `..` (this applies with or without auth).

**Ktor client.** A service using schemes the client can send gets a `<Service>Auth` class with one provider per
scheme, named after the camel-cased scheme id, passed to the API client (`features.auth: false` turns this off):

```kotlin
val api = PetStoreApiClient(http, baseUrl, PetStoreAuth(
    bearerAuth = { session.token },                            // suspend () -> String?
    partnerKey = { System.getenv("PARTNER_KEY") },
    // basicAuth = { BasicCredentials(user, password) },
))
```

Per request (per collection for event streams) the client sends the first alternative whose providers all return a
value (`null` and `""` are none; each provider is called at most once); `NoAuth`, or no satisfied alternative, sends
nothing and the server decides. Bearer/OAuth2/OpenID Connect tokens go in `Authorization: Bearer`, Basic in
`Authorization: Basic` (UTF-8, base64), API keys in their header, query parameter (replacing a same-named one) or
cookie. A credential replaces a header or query parameter of the same name (warning `auth-header-conflict`): in
the Ktor client credentials take precedence over an explicit header parameter, whereas the TypeScript clients let
per-call headers override credentials. Other http schemes warn `unsupported-auth-scheme`. Ktor's `Auth` plugin or
`defaultRequest` still work: pass no `auth`. Combined with generated credentials, the `Auth` plugin's bearer or
basic provider sets `Authorization` itself, replacing the generated one, while a `defaultRequest` header is added
next to it, so both `Authorization` values are sent.
