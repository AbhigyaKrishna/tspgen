import { expectDiagnostics } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { HEADER, sseServer } from "./tester.js";

const DIR = "server/com/acme/server";

const spec = `
  @service namespace S;
  model UserConnect { username: string; at: utcDateTime }
  @error model Oops { code: string }
  @events union ChannelEvents {
    userConnect: UserConnect,
    @Events.contentType("text/plain") note: string,
    @Events.contentType("text/plain") count: int32,
    @Events.contentType("text/plain") at: utcDateTime,
    seen: utcDateTime,
    @Events.contentType("text/plain") @terminalEvent "[done]",
  }
  @route("/feed") interface Feed {
    @get watch(@query room: string): SSEStream<ChannelEvents> | Oops;
    @post @route("/plugin") viaPlugin(@path id: string): SSEStream<ChannelEvents>;
    @get @route("/raw") raw(): { @header contentType: "text/event-stream"; @body body: string };
  }
  @@meta(Feed.viaPlugin, "kotlin:ktor-server", #{ sse: "plugin" });
`;

describe("ktor server server-sent events", () => {
  it("returns flows from the service and streams them through the chosen writer", async () => {
    const { outputs } = await sseServer().compile(spec.replace("@path id: string", "@query id: string"));
    expect(outputs[`${DIR}/FeedService.kt`]).toBe(`${HEADER}
package com.acme.server

import com.acme.models.ChannelEvents
import com.acme.models.SseMessage
import kotlinx.coroutines.flow.Flow

interface FeedService {
    suspend fun watch(room: String): Flow<ChannelEvents>
    suspend fun viaPlugin(id: String): Flow<ChannelEvents>
    suspend fun raw(): Flow<SseMessage>
}
`);
    expect(outputs[`${DIR}/FeedRoutes.kt`]).toBe(`${HEADER}
package com.acme.server

import io.ktor.http.HttpStatusCode
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.routing.post

fun Route.feedRoutes(service: FeedService) {
    get("/feed") {
        val room = call.queryParam("room").required("room")
        call.respondEventStream(service.watch(room)) { it.sseFrame() }
    }
    post("/feed/plugin") {
        val id = call.queryParam("id").required("id")
        call.respondSse(service.viaPlugin(id)) { it.sseFrame() }
    }
    get("/feed/raw") {
        call.respondEventStream(service.raw()) { it.sseFrame() }
    }
}
`);
  });

  it("writes frames in ServerSupport.kt: JSON payloads with the java.time-aware Json, text as-is or encoded", async () => {
    const { outputs } = await sseServer().compile(spec);
    const support = outputs[`${DIR}/ServerSupport.kt`];
    expect(support).toContain(`internal fun ChannelEvents.sseFrame(): TspgenSseFrame =
    when (this) {
        is ChannelEvents.UserConnectEvent -> TspgenSseFrame("userConnect", serverJson.encodeToJsonElement(data).toString())
        is ChannelEvents.Note -> TspgenSseFrame("note", data)
        is ChannelEvents.Count -> TspgenSseFrame("count", data.toString())
        is ChannelEvents.At -> TspgenSseFrame("at", data.toString())
        is ChannelEvents.Seen -> TspgenSseFrame("seen", serverJson.encodeToJsonElement(data).toString())
        ChannelEvents.Done -> TspgenSseFrame(null, "[done]", terminal = true)
    }
`);
    expect(support).toContain("internal fun SseMessage.sseFrame(): TspgenSseFrame = TspgenSseFrame(event, data, id)\n");
    expect(support).toContain("val serverJson: Json = Json(DefaultJson) {\n    encodeDefaults = false\n    serializersModule = modelSerializersModule\n}\n");
    expect(support).toContain(`    map(frame).transformWhile {
        emit(it)
        !it.terminal
    }`);
    expect(support).toContain(`    response.header("X-Accel-Buffering", "no")
    respondBytesWriter(ContentType.Text.EventStream) {
        events.sseFrames(frame).collect { f ->
            val text = StringBuilder()
            f.event?.let { text.append("event: ").append(it).append('\\n') }
            for (line in f.data.split("\\r\\n", "\\r", "\\n")) text.append("data: ").append(line).append('\\n')
            f.id?.let { text.append("id: ").append(it).append('\\n') }
            writeStringUtf8(text.append('\\n').toString())
            flush()
        }
    }`);
    expect(support).toContain(`    application.plugin(SSE)
    response.header("Cache-Control", "no-store")
    response.header("X-Accel-Buffering", "no")
    respond(
        SSEServerContent(this, {
            events.sseFrames(frame).collect { send(ServerSentEvent(data = it.data, event = it.event, id = it.id)) }
        }),
    )`);
    for (const i of [
      "com.acme.models.ChannelEvents",
      "com.acme.models.SseMessage",
      "com.acme.models.modelSerializersModule",
      "io.ktor.server.sse.SSE",
      "io.ktor.server.sse.SSEServerContent",
      "io.ktor.sse.ServerSentEvent",
      "io.ktor.server.response.respondBytesWriter",
      "kotlinx.coroutines.flow.transformWhile",
    ]) {
      expect(support).toContain(`import ${i}\n`);
    }
    // Flow is written qualified in ServerSupport.kt, so a model named Flow cannot clash with it.
    expect(support).not.toContain("import kotlinx.coroutines.flow.Flow\n");
    // CR/LF in event names and ids cannot end the line and forge fields or events; ids with NUL are dropped.
    expect(support).toContain(`internal class TspgenSseFrame(event: String?, val data: String, id: String? = null, val terminal: Boolean = false) {
    val event: String? = event?.filterNot { it == '\\r' || it == '\\n' }?.ifEmpty { null }
    val id: String? = id?.takeUnless { '\\u0000' in it }?.filterNot { it == '\\r' || it == '\\n' }
}`);
    expect(outputs[`${DIR}/SModule.kt`]).toContain("    install(SSE)\n    install(StatusPages) {");
    // REST and events share one Json: the module installs ServerSupport's serverJson.
    expect(outputs[`${DIR}/SModule.kt`]).toContain("        json(serverJson)\n");
    expect(outputs[`${DIR}/SModule.kt`]).not.toContain("import kotlinx.serialization.json.Json\n");
    expect(outputs[`${DIR}/SModule.kt`]).toContain("import io.ktor.server.sse.SSE\n");
  });

  it("uses the text writer only unless the option or meta picks the plugin", async () => {
    const textOnly = (await sseServer().compile(spec.replace(/@@meta\(Feed.viaPlugin.*\n/, ""))).outputs;
    expect(textOnly[`${DIR}/SModule.kt`]).not.toContain("SSE");
    expect(textOnly[`${DIR}/ServerSupport.kt`]).not.toContain("respondSse");
    expect(textOnly[`${DIR}/ServerSupport.kt`]).not.toContain("io.ktor.server.sse");

    const plugin = (await sseServer({ sse: "plugin" }).compile(spec.replace(/@@meta\(Feed.viaPlugin.*\n/, ""))).outputs;
    expect(plugin[`${DIR}/FeedRoutes.kt`]).toContain("call.respondSse(service.watch(room)) { it.sseFrame() }");
    expect(plugin[`${DIR}/ServerSupport.kt`]).not.toContain("respondEventStream");

    // A group-level meta, overridden by the operation's.
    const group = (
      await sseServer().compile(
        spec.replace(/@@meta\(Feed.viaPlugin.*\n/, `@@meta(Feed, "kotlin:ktor-server", #{ sse: "plugin" }); @@meta(Feed.raw, "kotlin:ktor-server", #{ sse: "text-writer" });\n`),
      )
    ).outputs[`${DIR}/FeedRoutes.kt`];
    expect(group).toContain("call.respondSse(service.watch(room))");
    expect(group).toContain("call.respondEventStream(service.raw())");
  });

  it("warns about an invalid sse meta value and keeps the option", async () => {
    const [{ outputs }, diagnostics] = await sseServer().compileAndDiagnose(spec.replace('sse: "plugin"', 'sse: "socket"'));
    expectDiagnostics(diagnostics, {
      code: "@abhigyakrishna/tspgen-core/invalid-meta",
      message: `Metadata key 'sse' on 'S.Feed.viaPlugin' must be "text-writer" or "plugin"; it is ignored.`,
    });
    expect(outputs[`${DIR}/FeedRoutes.kt`]).toContain("call.respondEventStream(service.viaPlugin(id))");
  });

  it("streams from resources routes and request-object handlers", async () => {
    const { outputs } = await sseServer({ "routing-style": "resources", "handler-shape": "request-object" }).compile(spec);
    const routes = outputs[`${DIR}/FeedRoutes.kt`];
    expect(routes).toContain(`    get<FeedResources.WatchResource> { resource ->
        val room = resource.room
        call.respondEventStream(service.watch(FeedService.WatchRequest(room = room))) { it.sseFrame() }
    }`);
    expect(routes).toContain(`    post<FeedResources.ViaPluginResource> { resource ->
        val id = resource.id
        call.respondSse(service.viaPlugin(FeedService.ViaPluginRequest(id = id))) { it.sseFrame() }
    }`);
    expect(outputs[`${DIR}/FeedService.kt`]).toContain("    suspend fun watch(request: WatchRequest): Flow<ChannelEvents>\n");
  });

  it("imports the stream helpers into routes of mapped packages", async () => {
    const { outputs } = await sseServer({}, { packages: [{ namespace: "S.Streams", package: "com.acme.streams" }] }).compile(`
      @service namespace S;
      model Tick { n: int32 }
      @events union Ticks { tick: Tick }
      namespace Streams {
        @route("/t") op ticks(): SSEStream<Ticks>;
      }
    `);
    const routes = outputs["server/com/acme/streams/StreamsRoutes.kt"];
    expect(routes).toContain("import com.acme.server.respondEventStream\n");
    expect(routes).toContain("import com.acme.server.sseFrame\n");
    expect(routes).not.toContain("import kotlinx.coroutines.flow.Flow\n");
    // No java.time: Ktor's DefaultJson without encoding defaults, which the module's content negotiation installs too.
    expect(outputs[`${DIR}/ServerSupport.kt`]).toContain("val serverJson: Json = Json(DefaultJson) {\n    encodeDefaults = false\n}\n");
    expect(outputs[`${DIR}/ServerSupport.kt`]).toContain("import io.ktor.serialization.kotlinx.json.DefaultJson\n");
    expect(outputs[`${DIR}/SModule.kt`]).toContain("        json(serverJson)\n");
  });

  it("adds nothing to ServerSupport.kt without streams", async () => {
    const { outputs } = await sseServer().compile(`
      @service namespace S;
      @route("/p") op ping(): string;
    `);
    expect(outputs[`${DIR}/ServerSupport.kt`]).not.toContain("SseFrame");
  });

  it("installs serverJson even when no event carries JSON", async () => {
    const { outputs } = await sseServer().compile(`
      @service namespace S;
      @route("/raw") op raw(): { @header contentType: "text/event-stream"; @body body: string };
    `);
    expect(outputs[`${DIR}/SModule.kt`]).toContain("        json(serverJson)\n");
    expect(outputs[`${DIR}/ServerSupport.kt`]).toContain("val serverJson: Json = Json(DefaultJson) {");
  });

  it("writes Flow qualified where a model is named Flow", async () => {
    const { outputs } = await sseServer().compile(`
      @service namespace S;
      model Flow { rate: int32 }
      model SseFrame { n: int32 }
      @events union Readings { flow: Flow, frame: SseFrame }
      @route("/r") op readings(): SSEStream<Readings>;
      @route("/f") op flow(): Flow;
    `);
    const service = outputs[`${DIR}/SService.kt`];
    expect(service).toContain("    suspend fun readings(): kotlinx.coroutines.flow.Flow<Readings>\n");
    expect(service).toContain("    suspend fun flow(): Flow\n");
    expect(service).toContain("import com.acme.models.Flow\n");
    expect(service).not.toContain("import kotlinx.coroutines.flow.Flow\n");
    expect(outputs[`${DIR}/ServerSupport.kt`]).toContain("        is Readings.Frame -> TspgenSseFrame(\"frame\", ");
  });

  it.each([
    [
      "dsl",
      `fun Route.feedRoutes(service: FeedService) {
    authenticate("BearerAuth") {
        get("/feed") {
            call.respondEventStream(service.watch()) { it.sseFrame() }
        }
        get("/feed/plugin") {
            call.respondSse(service.viaPlugin()) { it.sseFrame() }
        }
    }
    get("/feed/open") {
        call.respondEventStream(service.open()) { it.sseFrame() }
    }
}
`,
    ],
    [
      "resources",
      `fun Route.feedRoutes(service: FeedService) {
    authenticate("BearerAuth") {
        get<FeedResources.WatchResource> { resource ->
            call.respondEventStream(service.watch()) { it.sseFrame() }
        }
    }
    authenticate("BearerAuth") {
        get<FeedResources.ViaPluginResource> { resource ->
            call.respondSse(service.viaPlugin()) { it.sseFrame() }
        }
    }
    get<FeedResources.OpenResource> { resource ->
        call.respondEventStream(service.open()) { it.sseFrame() }
    }
}
`,
    ],
  ])("streams inside the authenticate(...) wrapper from @useAuth (%s routing, both writers)", async (style, expected) => {
    const { outputs } = await sseServer({ "routing-style": style }).compile(`
      @service @useAuth(BearerAuth) namespace S;
      @events union Ticks { tick: int32 }
      @route("/feed") interface Feed {
        @get watch(): SSEStream<Ticks>;
        @get @route("/plugin") viaPlugin(): SSEStream<Ticks>;
        @get @route("/open") @useAuth(NoAuth) open(): SSEStream<Ticks>;
      }
      @@meta(Feed.viaPlugin, "kotlin:ktor-server", #{ sse: "plugin" });
    `);
    const routes = outputs[`${DIR}/FeedRoutes.kt`];
    expect(routes).toContain("import io.ktor.server.auth.authenticate\n");
    expect(routes.slice(routes.indexOf("fun Route.feedRoutes"))).toBe(expected);
  });

  it("sets the sse-headers on both writers, in order", async () => {
    const support = (await sseServer({ "sse-headers": { "Cache-Control": "no-cache", "X-Stream": "a\"$b" } }).compile(spec))
      .outputs[`${DIR}/ServerSupport.kt`];
    expect(support).toContain(`internal suspend fun <T> ApplicationCall.respondEventStream(events: kotlinx.coroutines.flow.Flow<T>, frame: (T) -> TspgenSseFrame) {
    response.header("Cache-Control", "no-cache")
    response.header("X-Stream", "a\\"\\$b")
    respondBytesWriter(`);
    expect(support).toContain(`    application.plugin(SSE)
    response.header("Cache-Control", "no-cache")
    response.header("X-Stream", "a\\"\\$b")
    respond(`);
    expect(support).not.toContain("X-Accel-Buffering");
  });

  it("sets no headers with an empty sse-headers map", async () => {
    const support = (await sseServer({ "sse-headers": {} }).compile(spec)).outputs[`${DIR}/ServerSupport.kt`];
    expect(support).not.toContain("response.header(");
    expect(support).not.toContain("import io.ktor.server.response.header\n");
  });
});
