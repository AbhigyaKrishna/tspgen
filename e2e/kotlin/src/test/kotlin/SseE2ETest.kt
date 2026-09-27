package com.example.petstore

import com.example.petstore.api.ApiErrorException
import com.example.petstore.api.NotFoundException
import com.example.petstore.client.PetStoreApiClient
import com.example.petstore.client.petStoreDefaults
import com.example.petstore.models.ApiError
import com.example.petstore.models.FeedFilter
import com.example.petstore.models.NotFound
import com.example.petstore.models.Pet
import com.example.petstore.models.PetEvents
import com.example.petstore.models.SseMessage
import com.example.petstore.models.Species
import com.example.petstore.models.javaTimeSerializersModule
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import com.example.petstore.server.FeedService
import com.example.petstore.server.petStoreModule
import io.ktor.client.engine.cio.CIO as ClientCIO
import io.ktor.server.cio.CIO as ServerCIO
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.contentType
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.server.application.install
import io.ktor.server.auth.Authentication
import io.ktor.server.auth.bearer
import io.ktor.server.response.respondBytesWriter
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import io.ktor.utils.io.writeByteArray
import io.ktor.client.HttpClient
import io.ktor.server.engine.embeddedServer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.onCompletion
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.withTimeout
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

private val rex = Pet(id = 1, name = "Rex", species = Species.DOG, bornAt = Instant.parse("2020-01-01T00:00:00Z"))
private val seen = Instant.parse("2026-09-27T10:00:00.123Z")

/** The feed as the service streams it: the events after the terminal one must never reach the client. */
private val feed = listOf(
    PetEvents.Added(rex),
    PetEvents.Note("line one\nline two\r\nline three\rline four"),
    PetEvents.Note(""),
    PetEvents.Count(3),
    PetEvents.Seen(seen),
    PetEvents.Done,
    PetEvents.Note("after the end"),
)

/** The feed as received: CR, LF and CRLF line breaks all arrive as "\n". */
private val received = listOf(
    PetEvents.Added(rex),
    PetEvents.Note("line one\nline two\nline three\nline four"),
    PetEvents.Note(""),
    PetEvents.Count(3),
    PetEvents.Seen(seen),
    PetEvents.Done,
)

class DemoFeed : FeedService {
    /** Complete (with the cause) when an endless stream stops being collected. */
    val endlessStopped = CompletableDeferred<Throwable?>()
    val pluginStopped = CompletableDeferred<Throwable?>()

    override suspend fun watch(fail: Int?, endless: Boolean?): Flow<PetEvents> {
        when (fail) {
            404 -> throw NotFoundException(NotFound("no feed"))
            400 -> throw ApiErrorException(ApiError("bad_feed", "bad feed"), 400)
        }
        if (endless == true) return endless().onCompletion { endlessStopped.complete(it) }
        return feed.asFlowOfEvents()
    }

    private fun endless(): Flow<PetEvents> = flow {
        var n = 0
        while (true) {
            emit(PetEvents.Count(n++))
            delay(10)
        }
    }

    override suspend fun watchPlugin(filter: FeedFilter): Flow<PetEvents> {
        if (filter.species == Species.BIRD) throw NotFoundException(NotFound("no birds"))
        if (filter.endless == true) return endless().onCompletion { pluginStopped.complete(it) }
        return feed.asFlowOfEvents()
    }

    override suspend fun raw(count: Int): Flow<SseMessage> = flow {
        repeat(count) { emit(SseMessage("message $it", if (it == 1) "custom" else null, "$it")) }
    }
}

private fun List<PetEvents>.asFlowOfEvents(): Flow<PetEvents> = flow { forEach { emit(it) } }

/** Untyped messages whose id and event carry line breaks (and a NUL): they must not forge fields or events. */
class HostileFeed(private val base: FeedService = DemoFeed()) : FeedService by base {
    override suspend fun raw(count: Int): Flow<SseMessage> = flow {
        emit(SseMessage("real", event = "e\r\ndata: forged-event", id = "1\n\ndata: forged"))
        emit(SseMessage("next", id = "bad\u0000id"))
        emit(SseMessage("last", event = "\n"))
    }
}

class SseE2ETest {
    private fun feedApp(
        feed: FeedService = DemoFeed(),
        block: suspend ApplicationTestBuilder.(PetStoreApiClient) -> Unit,
    ) = testApplication {
        application {
            install(Authentication) { bearer("api") { authenticate { null } } }
            petStoreModule(
                extrasService = RecordingExtras(),
                petsService = InMemoryPets(),
                toysService = InMemoryToys(),
                accessoriesService = InMemoryAccessories(),
                uploadsService = RecordingUploads(),
                feedService = feed,
            )
        }
        block(PetStoreApiClient(createClient { petStoreDefaults() }, "http://localhost"))
    }

    @Test
    fun typedEventsThroughTheTextWriter() = feedApp { api ->
        assertEquals(received, api.feed.watch().toList())
    }

    @Test
    fun typedEventsThroughTheSsePlugin() = feedApp { api ->
        assertEquals(received, api.feed.watchPlugin(FeedFilter()).toList())
    }

    @Test
    fun wireFormatOfBothModes() = feedApp { _ ->
        val writer = client.get("/feed")
        assertEquals(ContentType.Text.EventStream, writer.headers[HttpHeaders.ContentType]?.let(ContentType::parse)?.withoutParameters())
        val text = writer.bodyAsText()
        assertTrue(text.startsWith("event: added\ndata: {\"id\":1,\"name\":\"Rex\",\"species\":\"dog\",\"born_at\":\"2020-01-01T00:00:00Z\"}\n\n"), text)
        assertTrue("event: note\ndata: line one\ndata: line two\ndata: line three\ndata: line four\n\n" in text, text)
        assertTrue("event: seen\ndata: \"2026-09-27T10:00:00.123Z\"\n\n" in text, text)
        // The terminal event is a default "message" event: no `event:` line.
        assertTrue(text.endsWith("event: count\ndata: 3\n\nevent: seen\ndata: \"2026-09-27T10:00:00.123Z\"\n\ndata: [done]\n\n"), text)
        val plugin = client.post("/feed/plugin") {
            contentType(ContentType.Application.Json)
            setBody("{}")
        }
        assertEquals(ContentType.Text.EventStream, plugin.headers[HttpHeaders.ContentType]?.let(ContentType::parse)?.withoutParameters())
        assertTrue("data: [done]" in plugin.bodyAsText())
    }

    @Test
    fun errorsBeforeStreamingKeepTheirStatus() = feedApp { api ->
        val missing = assertFailsWith<NotFoundException> { api.feed.watch(fail = 404).toList() }
        assertEquals(404, missing.status)
        assertEquals("no feed", missing.error.message)
        val bad = assertFailsWith<ApiErrorException> { api.feed.watch(fail = 400).toList() }
        assertEquals("bad_feed", bad.error.code)
        val birds = assertFailsWith<NotFoundException> { api.feed.watchPlugin(FeedFilter(Species.BIRD)).toList() }
        assertEquals("no birds", birds.error.message)
    }

    @Test
    fun untypedMessagesKeepEventAndId() = feedApp { api ->
        assertEquals(
            listOf(SseMessage("message 0", null, "0"), SseMessage("message 1", "custom", "1"), SseMessage("message 2", null, "2")),
            api.feed.raw(3).toList(),
        )
        assertEquals(emptyList(), api.feed.raw(0).toList())
    }

    /**
     * Over a real connection (the test engine buffers whole responses): events arrive while the server is still
     * streaming, the client flow is cold, and stopping its collection cancels the server's flow, in both modes.
     */
    @Test
    fun endlessStreamsOverARealConnection() = runBlocking {
        val feed = DemoFeed()
        val server = embeddedServer(ServerCIO, port = 0) {
            install(Authentication) { bearer("api") { authenticate { null } } }
            petStoreModule(
                extrasService = RecordingExtras(),
                petsService = InMemoryPets(),
                toysService = InMemoryToys(),
                accessoriesService = InMemoryAccessories(),
                uploadsService = RecordingUploads(),
                feedService = feed,
            )
        }.startSuspend()
        val http = HttpClient(ClientCIO) { petStoreDefaults() }
        try {
            val port = server.engine.resolvedConnectors().first().port
            val api = PetStoreApiClient(http, "http://localhost:$port")
            val counts = listOf(PetEvents.Count(0), PetEvents.Count(1), PetEvents.Count(2))
            withTimeout(20_000) {
                val flow = api.feed.watch(endless = true)
                assertEquals(counts, flow.take(3).toList())
                assertEquals(PetEvents.Count(0), flow.first())
                feed.endlessStopped.await()
                assertEquals(counts, api.feed.watchPlugin(FeedFilter(endless = true)).take(3).toList())
                feed.pluginStopped.await()
                assertEquals(received, api.feed.watch().toList())
                assertEquals(received, api.feed.watchPlugin(FeedFilter()).toList())
                assertFailsWith<NotFoundException> { api.feed.watch(fail = 404).toList() }
            }
        } finally {
            http.close()
            server.stopSuspend(0, 0)
        }
    }

    /** The generated client's parser against hand-written streams. */
    @Test
    fun clientParsesTheWireFormat() = testApplication {
        application {
            routing {
                get("/feed") {
                    // Written a few bytes at a time: CRLFs and multi-byte characters are split across reads.
                    val stream = listOf(
                        ": a comment\r\nretry: 1000\r\n",
                        "event: unknown\r\ndata: {\"skipped\":true}\r\n\r\n",
                        "event: note\r\ndata: café one\r\ndata:two\r\ndata\r\n\r\n",
                        "event: count\ndata: 7\n\n",
                        "event: count\rdata: 8\r\r",
                        "id: 9\ndata: [done]\n\n",
                        "event: count\ndata: 10\n\n",
                    ).joinToString("").encodeToByteArray()
                    val size = call.request.queryParameters["fail"]?.toInt() ?: 3
                    call.respondBytesWriter(ContentType.Text.EventStream) {
                        for (start in stream.indices step size) {
                            writeByteArray(stream.copyOfRange(start, minOf(start + size, stream.size)))
                            flush()
                        }
                    }
                }
                get("/feed/raw") {
                    call.respondBytesWriter(ContentType.Text.EventStream) {
                        val bytes = "data: héllo\n\nid: 7\nevent: e\ndata: x\n\ndata: unterminated".encodeToByteArray()
                        val split = bytes.indexOf(0xC3.toByte()) + 1
                        writeByteArray(bytes.copyOfRange(0, split))
                        flush()
                        writeByteArray(bytes.copyOfRange(split, bytes.size))
                        flush()
                    }
                }
            }
        }
        val api = PetStoreApiClient(createClient { petStoreDefaults() }, "http://localhost")
        val expected = listOf(PetEvents.Note("café one\ntwo\n"), PetEvents.Count(7), PetEvents.Count(8), PetEvents.Done)
        // `fail` doubles as the chunk size here.
        for (size in listOf(1, 2, 3, 5, 4096)) assertEquals(expected, api.feed.watch(fail = size).toList(), "chunk size $size")
        assertEquals(listOf(SseMessage("héllo", null, null), SseMessage("x", "e", "7")), api.feed.raw(1).toList())
    }

    @Test
    fun lineBreaksInIdsAndEventNamesCannotForgeEvents() = feedApp(HostileFeed()) { api ->
        assertEquals(
            listOf(
                SseMessage("real", "edata: forged-event", "1data: forged"),
                SseMessage("next", null, "1data: forged"),
                SseMessage("last", null, "1data: forged"),
            ),
            api.feed.raw(0).toList(),
        )
        val text = client.get("/feed/raw?count=0").bodyAsText()
        assertEquals("event: edata: forged-event\ndata: real\nid: 1data: forged\n\ndata: next\n\ndata: last\n\n", text)
    }

    @Test
    fun eventsCarryTheSameJsonAsRestResponses() = feedApp { api ->
        api.pets.create(rex)
        val rest = client.get("/pets/1").bodyAsText()
        val stream = client.get("/feed").bodyAsText()
        assertTrue(stream.startsWith("event: added\ndata: $rest\n\n"), "$rest\n$stream")
    }

    /** A hand-written stream with a byte order mark and a field the models do not declare. */
    @Test
    fun clientJsonOptionsAndByteOrderMark() = testApplication {
        application {
            routing {
                get("/feed") {
                    val body = "\uFEFFevent: added\ndata: {\"id\":1,\"name\":\"Rex\",\"species\":\"dog\",\"extra\":true}\n\ndata: [done]\n\n"
                    call.respondBytesWriter(ContentType.Text.EventStream) { writeByteArray(body.encodeToByteArray()) }
                }
            }
        }
        val lenient = Json { ignoreUnknownKeys = true; serializersModule = javaTimeSerializersModule }
        val api = PetStoreApiClient(createClient { petStoreDefaults(lenient) }, "http://localhost")
        assertEquals(
            listOf(PetEvents.Added(Pet(id = 1, name = "Rex", species = Species.DOG)), PetEvents.Done),
            api.feed.watch(fail = 1).toList(),
        )
        val strict = PetStoreApiClient(createClient { petStoreDefaults() }, "http://localhost")
        assertFailsWith<SerializationException> { strict.feed.watch(fail = 1).toList() }
    }

    /** A line over the client's 1 MiB limit fails the stream (over CIO: the test engine buffers whole responses). */
    @Test
    fun oversizedLinesFailTheStream() = runBlocking {
        val server = embeddedServer(ServerCIO, port = 0) {
            routing {
                get("/feed") {
                    call.respondBytesWriter(ContentType.Text.EventStream) {
                        writeByteArray(("data: " + "x".repeat((1 shl 20) + 1) + "\n\n").encodeToByteArray())
                    }
                }
            }
        }.startSuspend()
        val http = HttpClient(ClientCIO) { petStoreDefaults() }
        try {
            val port = server.engine.resolvedConnectors().first().port
            val api = PetStoreApiClient(http, "http://localhost:$port")
            val tooLong = assertFailsWith<IllegalStateException> { withTimeout(20_000) { api.feed.watch().toList() } }
            assertEquals("Server-sent event line longer than 1048576 bytes", tooLong.message)
        } finally {
            http.close()
            server.stopSuspend(0, 0)
        }
    }
}
