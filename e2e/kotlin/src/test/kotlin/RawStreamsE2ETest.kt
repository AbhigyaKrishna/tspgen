package com.example.rawstreams

import com.example.rawstreams.api.WithHeadersResult
import com.example.rawstreams.client.RawStreamsApiClient
import com.example.rawstreams.client.RawBytesContent
import com.example.rawstreams.client.rawStreamsDefaults
import com.example.rawstreams.client.readRawText as readClientRawText
import com.example.rawstreams.models.Message
import com.example.rawstreams.models.SseMessage
import com.example.rawstreams.server.StreamsService
import com.example.rawstreams.server.rawStreamsModule
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO as ClientCIO
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.cio.CIO as ServerCIO
import io.ktor.server.engine.embeddedServer
import io.ktor.server.testing.testApplication
import io.ktor.utils.io.ByteReadChannel
import io.ktor.utils.io.ByteChannel
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs

private val binaryValue = ByteArray(20_000) { (it % 256).toByte() }
private val textChunks = listOf("x".repeat(8191), "\uD83D", "\uDCA1é\r\n", "日本\nend")
private val textValue = textChunks.joinToString("")

private fun List<ByteArray>.joined(): ByteArray = flatMap { it.asList() }.toByteArray()

private class RecordingRawStreams : StreamsService {
    var binaryCalls = 0
    var binaryGate: CompletableDeferred<Unit>? = null
    val endlessStopped = CompletableDeferred<Unit>()
    var uploadSeen: CompletableDeferred<Unit>? = null
    var uploadedStream: Flow<ByteArray>? = null
    var uploadedBytes = byteArrayOf()
    var uploadedText = ""

    override suspend fun binary(): Flow<ByteArray> = flow {
        binaryCalls++
        emit(binaryValue.copyOfRange(0, 1))
        binaryGate?.await()
        emit(binaryValue.copyOfRange(1, binaryValue.size))
    }

    override suspend fun endless(): Flow<ByteArray> = flow {
        try {
            while (true) { emit(ByteArray(8192) { 42 }); delay(10) }
        } finally {
            endlessStopped.complete(Unit)
        }
    }

    override suspend fun text() = flowOf(*textChunks.toTypedArray())
    override suspend fun utf16() = text()

    override suspend fun upload(request: StreamsService.UploadRequest): Int {
        uploadedStream = request.body
        val chunks = mutableListOf<ByteArray>()
        request.body.collect { chunks += it; uploadSeen?.complete(Unit) }
        uploadedBytes = chunks.joined()
        return uploadedBytes.size
    }

    override suspend fun uploadText(request: StreamsService.UploadTextRequest): Int {
        uploadedText = request.body.toList().joinToString("")
        return uploadedText.length
    }

    override suspend fun uploadUtf16(request: StreamsService.UploadUtf16Request): Int =
        uploadText(StreamsService.UploadTextRequest(request.body))

    override suspend fun withHeaders(request: StreamsService.WithHeadersRequest): WithHeadersResult =
        if (request.empty == true) WithHeadersResult.NoContent
        else WithHeadersResult.PartialContent(binary(), "raw-trace")

    override suspend fun events(request: StreamsService.EventsRequest) = flowOf(SseMessage(request.message.prefix))
}

class RawStreamsE2ETest {
    @Test
    fun generatedTransportsPreserveRawBytesCharsetsAndResponseMetadata() = testApplication {
        val service = RecordingRawStreams()
        application { rawStreamsModule(service) }
        val api = RawStreamsApiClient(createClient { rawStreamsDefaults() }, "")
        assertContentEquals(binaryValue, api.streams.binary().toList().joined())
        assertEquals(textValue, api.streams.text().toList().joinToString(""))
        assertEquals(textValue, api.streams.utf16().toList().joinToString(""))
        assertEquals(binaryValue.size, api.streams.upload(flowOf(binaryValue)))
        assertContentEquals(binaryValue, service.uploadedBytes)
        assertFailsWith<IllegalStateException> { service.uploadedStream!!.toList() }
        assertEquals(0, api.streams.upload(emptyFlow()))
        assertEquals(textValue.length, api.streams.uploadText(flowOf(*textChunks.toTypedArray())))
        assertEquals(textValue, service.uploadedText)
        assertEquals(textValue.length, api.streams.uploadUtf16(flowOf(*textChunks.toTypedArray())))
        assertEquals(textValue, service.uploadedText)
        assertEquals(0, api.streams.uploadText(emptyFlow()))

        var expired: Flow<ByteArray>? = null
        api.streams.withHeaders { result ->
            val partial = assertIs<WithHeadersResult.PartialContent>(result)
            assertEquals("raw-trace", partial.trace)
            assertContentEquals(binaryValue, partial.body.toList().joined())
            assertFailsWith<IllegalStateException> { partial.body.toList() }
            expired = partial.body
        }
        assertFailsWith<IllegalStateException> { expired!!.toList() }
        api.streams.withHeaders(empty = true) { assertEquals(WithHeadersResult.NoContent, it) }
        assertEquals(listOf("from-json"), api.streams.events(Message("from-json")).toList().map { it.data })
    }

    @Test
    fun malformedTextAndUnsupportedRequestMediaTypesAreRejected() = testApplication {
        application { rawStreamsModule(RecordingRawStreams()) }
        assertEquals(HttpStatusCode.BadRequest, client.post("/raw/text") {
            contentType(ContentType.Text.Plain)
            setBody(byteArrayOf(0xc3.toByte()))
        }.status)
        assertEquals(HttpStatusCode.UnsupportedMediaType, client.post("/raw/bytes") {
            contentType(ContentType.Application.Json)
            setBody("{}")
        }.status)
        assertEquals(HttpStatusCode.UnsupportedMediaType, client.post("/raw/text") {
            contentType(ContentType.parse("text/plain; charset=not-a-charset"))
            setBody(byteArrayOf(65))
        }.status)
    }

    @Test
    fun decoderPreservesSplitCharactersAndRejectsIncompleteFinalCharacters(): Unit = runBlocking {
        val chunks = mutableListOf<String>()
        ByteReadChannel(textValue.encodeToByteArray()).readClientRawText(Charsets.UTF_8) { chunks += it }
        assertEquals(textValue, chunks.joinToString(""))
        assertFailsWith<IllegalArgumentException> {
            ByteReadChannel(byteArrayOf(0xc3.toByte())).readClientRawText(Charsets.UTF_8) { }
        }
    }

    @Test
    fun anOutgoingRequestCannotReplayItsStream(): Unit = runBlocking {
        val content = RawBytesContent(flowOf(byteArrayOf(1, 2, 3)), "application/octet-stream")
        val sink = ByteChannel(autoFlush = true)
        try {
            content.writeTo(sink)
            assertFailsWith<IllegalStateException> { content.writeTo(sink) }
        } finally {
            sink.cancel(null)
        }
    }

    @Test
    fun realConnectionsStreamBothDirectionsAndCancelTheProducer() = runBlocking {
        val service = RecordingRawStreams()
        val release = CompletableDeferred<Unit>()
        service.binaryGate = release
        service.uploadSeen = CompletableDeferred()
        val server = embeddedServer(ServerCIO, port = 0) { rawStreamsModule(service) }.startSuspend()
        val http = HttpClient(ClientCIO) { rawStreamsDefaults() }
        try {
            val port = server.engine.resolvedConnectors().first().port
            val api = RawStreamsApiClient(http, "http://localhost:$port")
            withTimeout(20_000) {
                val download = api.streams.binary()
                assertEquals(0, service.binaryCalls)
                val chunks = mutableListOf<ByteArray>()
                download.collect { chunk -> chunks += chunk; release.complete(Unit) }
                assertContentEquals(binaryValue, chunks.joined())
                assertEquals(binaryValue.size, api.streams.upload(flow {
                    emit(binaryValue.copyOfRange(0, 1))
                    service.uploadSeen!!.await()
                    emit(binaryValue.copyOfRange(1, binaryValue.size))
                }))
                assertContentEquals(binaryValue, service.uploadedBytes)
                assertEquals(42, api.streams.endless().first().first().toInt())
                service.endlessStopped.await()
            }
        } finally {
            release.complete(Unit)
            http.close()
            server.stopSuspend(0, 0)
        }
    }
}
