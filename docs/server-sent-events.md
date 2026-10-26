# Server-sent events

```tsp
import "@typespec/sse";   // with @typespec/events and @typespec/streams

@TypeSpec.Events.events
union PetEvents {
  added: Pet,                                            // event: added, JSON data
  @TypeSpec.Events.contentType("text/plain") note: string,
  count: int32,
  @TypeSpec.Events.contentType("text/plain") @TypeSpec.SSE.terminalEvent "[done]",   // unnamed: event "message"
}

@route("/feed") interface Feed {
  @get watch(@query room: string): TypeSpec.SSE.SSEStream<PetEvents> | NotFound;
  @get @route("/raw") raw(): { @header contentType: "text/event-stream"; @body body: string };   // untyped
}
```

`@typespec/streams`, `@typespec/events` and `@typespec/sse` (0.86.x, matching `@typespec/http` 1.16) are
**optional peer dependencies** of `@abhigyakrishna/tspgen-core`: install them next to tspgen to use
`SSEStream<…>`. The emitter pipeline imports them (dynamic `import()`, from tspgen-core's location) only when the
spec uses streams or events, and hands them to `buildApiIR` (`BuildOptions.sse`, from `loadSseLibraries()`);
core has no top-level await, so it can still be `require`d. Without them (or when tspgen cannot resolve them) every
`text/event-stream` response is an untyped stream, and an `SSEStream<…>` operation warns
`sse-libraries-missing`; code calling `buildApiIR` directly without `sse` gets the same untyped fallback. Specs
without event streams generate exactly what they did before.

Each variant of an `@events` union is one event: its name is the SSE `event:` (an unnamed variant is the default
`message` event), its payload the variant type — or the `@data` property of an event envelope (the envelope's
other properties are not sent) — encoded as its `@contentType`, by default `text/plain` for strings and string
literals and `application/json` otherwise. A literal payload (`"[done]"`) identifies its event by its data, so
several unnamed variants can share the `message` event. `@terminalEvent` ends the stream: the server stops after
sending it and the clients stop reading. Any other `text/event-stream` response (no `SSEStream`) is an **untyped**
stream of `SseMessage { data, event?, id? }`. An `@events` union is generated only for the streams (and other types)
that use it; used as a regular JSON type (a model property, a request or JSON response body) it warns
`events-in-json`, as the event types have no JSON form.

| Target | Typed stream (`SSEStream<PetEvents>`) | Untyped stream |
|---|---|---|
| Kotlin models | `sealed interface PetEvents` (not `@Serializable`) with `data class Added(val data: Pet)`, …, `data object Done` for literal payloads; a class whose name would shadow a payload type (`userConnect: UserConnect`) gets an `Event` suffix | `data class SseMessage(data, event?, id?)`, generated once when used |
| Ktor server | `suspend fun watch(room: String): Flow<PetEvents>` | `Flow<SseMessage>` |
| Ktor client | `fun watch(room: String): Flow<PetEvents>` — cold: collecting it sends the request | `Flow<SseMessage>` |
| TypeScript models | `type PetEvents = \| { event: "added"; data: Pet } \| …` (zod: `z.discriminatedUnion("event", …)`, `z.union` when event names repeat) | `interface SseMessage { event?; data; id? }` |
| Next.js grouped client | `async *watch(params, options?): AsyncIterable<PetEvents>` | `AsyncIterable<SseMessage>` |
| Next.js flat client | `async *watch(query, init?: { signal?: AbortSignal }): AsyncIterable<PetEvents>` | `AsyncIterable<SseMessage>` |

- **Ktor server.** The route calls the service first and streams the returned flow afterwards, so an exception
  the service throws before returning the flow (e.g. `NotFoundException`) still answers with its status; once the
  flow is being collected the response has started and an exception only ends the stream. Pick the writer with the
  `sse` option, or per operation / interface / namespace with `@@meta(Feed.watch, "kotlin:ktor-server", #{ sse:
  "plugin" })` (other values warn `invalid-meta` and fall back to the option):
  - `text-writer` (default, no extra dependency): writes `text/event-stream` itself with `respondBytesWriter`
    (non-blocking), one `event:` / `data:` (one line per line of data) / blank-line block per event, flushed per
    event;
  - `plugin`: responds through the `ktor-server-sse` plugin (`SSEServerContent`, `ServerSentEvent`s); add
    `io.ktor:ktor-server-sse` to your build. The generated module installs `SSE` when any operation uses it; with
    `features.module: false`, `install(SSE)` yourself.

  Both work with every routing style and handler shape (routes stay regular `get`/`post`/… routes, inside the
  `authenticate(...)` wrapper generated from `@useAuth` like any other route) and send the `sse-headers` (default
  `Cache-Control: no-store` and `X-Accel-Buffering: no`; a configured map replaces them, `{}` sends none;
  `Content-Type`, `Content-Length`, `Transfer-Encoding` and `Upgrade` are rejected). JSON payloads are encoded with
  `serverJson`, the Json the generated module's content negotiation installs, so an event carries exactly the JSON a
  REST response would; with `features.module: false` and your own content negotiation, events still use `serverJson`.
  Text payloads are sent
  as-is (strings) or as their wire string (numbers, java.time values, enums); CR and CRLF line breaks in data
  become separate `data:` lines, so clients receive them as LF. CR and LF are removed from `SseMessage` event
  names and ids (they would otherwise forge fields or events) and an id containing NUL is dropped. Streams retain
  their declared success status and response headers. No heartbeat / keep-alive comments are sent: a client that
  disconnects while the stream is idle is noticed on the next write (which cancels the service's flow).
- **Ktor client.** Collecting the flow executes the request (`Accept: text/event-stream`); a non-2xx response
  throws the operation's usual exceptions before any event; events are parsed by a small generated reader
  (`ClientSupport.kt`: CRLF/LF/CR line ends, comments, `retry:`, multi-line data, lines and UTF-8 characters split
  across reads, a leading byte order mark) and decoded by event name; unknown events are skipped; a terminal event
  ends the flow; cancelling the collection closes the response. JSON payloads decode with the Json given to
  `<service>Defaults(format)` (e.g. `ignoreUnknownKeys`), else that function's default; a malformed payload throws
  from the flow (`SerializationException`, `NumberFormatException`, …), as does a line or event over 1 MiB
  (`IllegalStateException`). No Ktor SSE client plugin is needed. `HttpTimeout`'s `requestTimeoutMillis` covers
  the whole streamed response, so it cuts long streams: leave it unset (or infinite) for clients that stream.
- **Next.js clients.** The methods are async generators: the request is sent on the first iteration, with the
  usual auth/config headers and `Accept: text/event-stream`, and a non-2xx response throws the usual error there.
  JSON payloads are `JSON.parse`d and, in the grouped client, validated with the zod schema unless
  `validate: false`; unknown events are skipped; a terminal event ends the iteration. `break`ing out of
  `for await` cancels the response body; `RequestOptions.signal` (grouped) / `init.signal` (flat) aborts the
  request, rejecting the iteration with fetch's abort error. A payload that fails mid-stream — malformed JSON, a
  number or boolean text payload that isn't one, a zod validation error, a line or event over 1 MiB — throws from
  the iteration and ends it. `Accept: text/event-stream` is set only when the configured / per-call headers have no
  `accept`: a global `accept` header in `ClientConfig.headers` (or `ClientOptions.headers`) overrides it. `@useAuth`
  credentials are sent with stream requests like any other. React Query hooks (grouped and flat) and Server
  Actions skip streaming operations — call the client directly.
- In TypeScript, only the single success response of an operation can stream: a `text/event-stream` response next to other
  success responses or with response headers warns `unsupported-sse-response` and is treated as a text body.
- Kotlin responses with headers or multiple success variants use the scoped callback API below. TypeScript
  does not support JSON Lines. Neither language implements SSE request bodies, arbitrary stream framing,
  reconnection / `Last-Event-ID` (the clients report `id:` on `SseMessage` only), or sending `id:` / `retry:` from
  typed events. In Kotlin, a model of your own named `SseMessage` in the models package clashes with the untyped
  message class (`sse-message-conflict`), as does a TypeScript type named `SseMessage`; rename it with
  `@Kotlin.name` / `@TS.name`.


## JSON Lines (Kotlin)

Ktor client and server support `TypeSpec.Http.Streams.JsonlStream<T>` as request and response bodies:

```tsp
import "@typespec/http/streams";
@get op lines(): TypeSpec.Http.Streams.JsonlStream<Pet>;
@post op ingest(...TypeSpec.Http.Streams.JsonlStream<Pet>): int32;
```

A response becomes a cold client `Flow<T>` and a service `Flow<T>`. A request becomes a streamed `Flow<T>`
parameter on both sides. Each nonblank line is one JSON value; `application/jsonl` and
`application/x-ndjson` are recognized. Writers flush each item; codecs honor encoded scalars and the
shared JSON configuration. Malformed request items answer 400 before a response starts, and an incorrect
request media type answers 415. Cancellation closes the request/response scope.

As with SSE, an exception after response streaming starts terminates that stream.

## Kotlin response headers and alternate successes

A single fixed success response without headers keeps the cold client `Flow<T>` API. SSE and JSON Lines
responses with headers, several success variants or non-fixed statuses return their generated result through
a suspend callback. Each streaming variant carries `body: Flow<T>` and its declared headers:

```tsp
@route("/feed") interface Feed {
  @get watch(): {
    @statusCode status: 201;
    @header trace: string;
    ...TypeSpec.Http.Streams.JsonlStream<Pet>;
  } | { @statusCode status: 204; };
}
```

```kotlin
api.feed.watch { result ->
    when (result) {
        is WatchResult.Created -> {
            println(result.trace)
            result.body.collect { pet -> println(pet.name) }
        }
        WatchResult.NoContent -> Unit
    }
}
```

Collect the flow once inside the callback. Returning, throwing or cancelling closes the response;
collection after the callback or a second collection fails with `IllegalStateException`. Non-streaming
variants are decoded before the callback. Declared errors use the usual typed exceptions. Responses sharing
a status are selected by their declared content type. The service returns the same result type with a
streaming body; the server writes its status and headers before collecting that body. Both SSE writer
modes support these results.
