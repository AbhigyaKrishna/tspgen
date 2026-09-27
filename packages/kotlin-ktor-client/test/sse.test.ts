import { describe, expect, it } from "vitest";
import { client, HEADER, sseClient } from "./tester.js";

const DIR = "client/com/acme/client";

const spec = `
  @service namespace S;
  model UserConnect { username: string }
  @error model Oops { code: string }
  @events union ChannelEvents {
    userConnect: UserConnect,
    @Events.contentType("text/plain") count: int32,
    @Events.contentType("text/plain") at: utcDateTime,
    seen: utcDateTime,
    @Events.contentType("text/plain") @terminalEvent "[done]",
    @Events.contentType("text/plain") "[skip]",
    string,
    @terminalEvent bye: UserConnect,
  }
  @route("/feed") interface Feed {
    @get watch(@query room: string, @header("x-trace") trace?: string): SSEStream<ChannelEvents> | Oops;
    @get @route("/raw") raw(): { @header contentType: "text/event-stream"; @body body: string };
  }
`;

describe("ktor client server-sent events", () => {
  it("returns cold flows that request the stream when collected", async () => {
    const { outputs } = await sseClient().compile(spec);
    expect(outputs[`${DIR}/FeedClient.kt`]).toBe(`${HEADER}
package com.acme.client

import com.acme.api.ApiException
import com.acme.api.OopsException
import com.acme.models.ChannelEvents
import com.acme.models.SseMessage
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.header
import io.ktor.client.request.prepareRequest
import io.ktor.client.request.request
import io.ktor.client.statement.bodyAsChannel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.appendPathSegments
import io.ktor.http.isSuccess
import io.ktor.http.takeFrom
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

class FeedClient(
    private val http: HttpClient,
    private val baseUrl: String,
) {
    fun watch(room: String, trace: String? = null): Flow<ChannelEvents> = flow {
        val json = http.sseJson
        http.prepareRequest {
            method = HttpMethod.Get
            url {
                takeFrom(baseUrl)
                appendPathSegments("feed")
                parameters.append("room", room)
            }
            header(HttpHeaders.Accept, "text/event-stream")
            trace?.let { header("x-trace", it) }
        }.execute { response ->
            if (!response.status.isSuccess()) {
                throw when (response.status.value) {
                    else -> OopsException(response.body(), response.status.value)
                }
            }
            response.bodyAsChannel().readSse { event ->
                val value = decodeChannelEvents(event, json) ?: return@readSse true
                emit(value)
                !value.sseTerminal()
            }
        }
    }

    fun raw(): Flow<SseMessage> = flow {
        http.prepareRequest {
            method = HttpMethod.Get
            url {
                takeFrom(baseUrl)
                appendPathSegments("feed", "raw")
            }
            header(HttpHeaders.Accept, "text/event-stream")
        }.execute { response ->
            if (!response.status.isSuccess()) {
                throw when (response.status.value) {
                    else -> ApiException(response.status.value, response.bodyAsText())
                }
            }
            response.bodyAsChannel().readSse { event ->
                emit(SseMessage(event.data, event.event, event.id))
                true
            }
        }
    }
}
`);
  });

  it("decodes events by name, literal data first, in ClientSupport.kt", async () => {
    const { outputs } = await sseClient().compile(spec);
    const support = outputs[`${DIR}/ClientSupport.kt`];
    expect(support).toContain(`internal fun decodeChannelEvents(event: TspgenSseEvent, json: Json): ChannelEvents? =
    when (event.event ?: "message") {
        "userConnect" -> ChannelEvents.UserConnectEvent(json.decodeFromString<UserConnect>(event.data))
        "count" -> ChannelEvents.Count(event.data.toInt())
        "at" -> ChannelEvents.At(Instant.parse(event.data))
        "seen" -> ChannelEvents.Seen(json.decodeFromString<Instant>(event.data))
        "message" ->
            when (event.data) {
                "[done]" -> ChannelEvents.Done
                "[skip]" -> ChannelEvents.Skip
                else -> ChannelEvents.Message(event.data)
            }
        "bye" -> ChannelEvents.Bye(json.decodeFromString<UserConnect>(event.data))
        else -> null
    }
`);
    expect(support).toContain(
      "internal fun ChannelEvents.sseTerminal(): Boolean = this is ChannelEvents.Done || this is ChannelEvents.Bye\n",
    );
    expect(support).toContain("private val defaultSseJson: Json = Json { serializersModule = javaTimeSerializersModule }\n");
    expect(support).toContain(`internal fun sseJsonPlugin(format: Json): ClientPlugin<Unit> =
    createClientPlugin("TspgenSseJson") { client.attributes.put(sseJsonKey, format) }`);
    expect(support).toContain("internal suspend fun ByteReadChannel.readSse(onEvent: suspend (TspgenSseEvent) -> Boolean) {");
    // Event payloads decode with the Json given to the defaults function.
    expect(outputs[`${DIR}/SApiClient.kt`]).toContain(`    install(ContentNegotiation) {
        json(format)
    }
    install(sseJsonPlugin(format))
}`);
    for (const i of ["com.acme.models.ChannelEvents", "com.acme.models.UserConnect", "java.time.Instant", "io.ktor.utils.io.readAvailable"]) {
      expect(support).toContain(`import ${i}\n`);
    }
  });

  it("parses lines ending in CRLF, LF or CR, skips comments and dispatches only complete events", async () => {
    const { outputs } = await sseClient().compile(spec);
    const support = outputs[`${DIR}/ClientSupport.kt`];
    expect(support).toContain(`            if (byte == LF && afterCr) {
                afterCr = false
                start = i + 1
                continue
            }
            afterCr = byte == CR`);
    expect(support).toContain(`                if (hasData && !onEvent(TspgenSseEvent(event, data.toString(), id))) return`);
    expect(support).toContain(`                text = text.removePrefix("\\uFEFF")`);
    expect(support).toContain("internal const val MAX_SSE_SIZE: Int = 1 shl 20\n");
    expect(support).toContain(`check(lineSize + size <= MAX_SSE_SIZE) { "Server-sent event line longer than $MAX_SSE_SIZE bytes" }`);
    expect(support).not.toContain("ByteArrayOutputStream");
    expect(support).toContain(`            if (text.startsWith(":")) continue`);
    expect(support).toContain(`"id" -> if ('\\u0000' !in value) id = value`);
  });

  it("adds no stream support without streaming operations", async () => {
    const { outputs } = await client().compile(`
      @service namespace S;
      @route("/p") op ping(): string;
    `);
    expect(outputs[`${DIR}/ClientSupport.kt`]).not.toContain("readSse");
    expect(outputs[`${DIR}/SClient.kt`]).not.toContain("prepareRequest");
    expect(outputs[`${DIR}/SApiClient.kt`]).not.toContain("sseJsonPlugin");
  });

  it("writes Flow qualified where a model is named Flow, and keeps SseEvent / SseFrame models apart", async () => {
    const { outputs } = await sseClient().compile(`
      @service namespace S;
      model Flow { rate: int32 }
      model SseEvent { n: int32 }
      @events union Readings { flow: Flow, event: SseEvent }
      @route("/r") op readings(): SSEStream<Readings>;
    `);
    const client = outputs[`${DIR}/SClient.kt`];
    expect(client).toContain("    fun readings(): kotlinx.coroutines.flow.Flow<Readings> = flow {\n");
    expect(client).not.toContain("import kotlinx.coroutines.flow.Flow\n");
    const support = outputs[`${DIR}/ClientSupport.kt`];
    expect(support).toContain("import com.acme.models.SseEvent\n");
    expect(support).toContain(`"event" -> Readings.Event(json.decodeFromString<SseEvent>(event.data))`);
  });
});
