package com.example.socket

import com.example.socket.client.SocketApiClient
import com.example.socket.client.SocketAuth
import com.example.socket.client.socketDefaults
import com.example.socket.models.Message
import io.ktor.client.HttpClient
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.receiveDeserialized
import io.ktor.client.plugins.websocket.sendSerialized
import io.ktor.http.HttpHeaders
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.engine.embeddedServer
import io.ktor.server.request.queryString
import io.ktor.server.routing.routing
import io.ktor.server.testing.testApplication
import io.ktor.server.websocket.webSocket
import io.ktor.websocket.Frame
import io.ktor.websocket.readBytes
import io.ktor.websocket.readText
import io.ktor.websocket.send
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertSame
import io.ktor.client.engine.cio.CIO as ClientCIO
import io.ktor.server.cio.CIO as ServerCIO
import io.ktor.server.websocket.WebSockets as ServerWebSockets

class WebSocketClientE2ETest {
    @Test
    fun typedJsonAndBinaryFramesRetainHandshakeParametersAndRotatingCredentials() =
        testApplication {
            var token = "first"
            var providerCalls = 0
            application { configureEchoServer { token } }
            val http = createClient { socketDefaults() }
            val auth =
                SocketAuth(bearerAuth = {
                    providerCalls++
                    token
                })
            val api = SocketApiClient(http, "http://localhost/base", auth)
            for (nextToken in listOf("first", "second")) {
                token = nextToken
                api.sockets.connect("room one", "Server&Other", "trace", "session", listOf("a[0]&b", "c/d"), listOf(1, 2)) { session ->
                    val message = Message(9007199254740993L, "login")
                    session.sendSerialized(message)
                    assertEquals("LOGGED_IN", assertIs<Frame.Text>(session.incoming.receive()).readText())
                    assertEquals(message, session.receiveDeserialized<Message>())
                    session.send(Frame.Binary(true, byteArrayOf(0, -1, 42)))
                    assertContentEquals(byteArrayOf(0, -1, 42), assertIs<Frame.Binary>(session.incoming.receive()).readBytes())
                }
            }
            assertEquals(2, providerCalls)
        }

    @Test
    fun returningFromTheConsumerClosesTheConnection() =
        runBlocking {
            withSocketServer { api, closed ->
                api.sockets.closing { session -> assertReady(session) }
                closed.receive()
            }
        }

    @Test
    fun aConsumerFailureClosesTheConnectionAndPreservesTheException() =
        runBlocking {
            withSocketServer { api, closed ->
                val failure = IllegalStateException("consumer failed")
                val caught =
                    assertFailsWith<IllegalStateException> {
                        api.sockets.closing { session ->
                            assertReady(session)
                            throw failure
                        }
                    }
                assertSame(failure, caught)
                closed.receive()
            }
        }

    @Test
    fun cancellingTheConsumerClosesTheConnection() =
        runBlocking {
            withSocketServer { api, closed ->
                val consuming = CompletableDeferred<Unit>()
                val job =
                    launch {
                        api.sockets.closing { session ->
                            assertReady(session)
                            consuming.complete(Unit)
                            awaitCancellation()
                        }
                    }
                consuming.await()
                job.cancelAndJoin()
                closed.receive()
            }
        }

    private fun Application.configureEchoServer(token: () -> String) {
        install(ServerWebSockets)
        routing {
            webSocket("/base/rooms/{room}") {
                val keys =
                    call.request
                        .queryString()
                        .split('&')
                        .map { it.substringBefore('=') }
                        .toSet()
                assertEquals(setOf("target[type]", "labels[]", "ids[]"), keys)
                assertEquals(listOf("a[0]&b", "c/d"), call.request.queryParameters.getAll("labels[]"))
                assertEquals("1,2", call.request.queryParameters["ids[]"])
                assertEquals("room one", call.parameters["room"])
                assertEquals("Server&Other", call.request.queryParameters["target[type]"])
                assertEquals("trace", call.request.headers["x-trace"])
                assertEquals("sid=session", call.request.headers[HttpHeaders.Cookie])
                assertEquals("Bearer ${token()}", call.request.headers[HttpHeaders.Authorization])
                val message = assertIs<Frame.Text>(incoming.receive()).readText()
                assertEquals(
                    Json.parseToJsonElement("""{"id":"9007199254740993","text":"login"}"""),
                    Json.parseToJsonElement(message),
                )
                send("LOGGED_IN")
                send(message)
                send(assertIs<Frame.Binary>(incoming.receive()))
            }
        }
    }

    private suspend fun assertReady(session: DefaultClientWebSocketSession) {
        assertEquals("ready", assertIs<Frame.Text>(session.incoming.receive()).readText())
    }

    private suspend fun withSocketServer(test: suspend (SocketApiClient, ReceiveChannel<Unit>) -> Unit) {
        val closed = Channel<Unit>(Channel.UNLIMITED)
        val server =
            embeddedServer(ServerCIO, port = 0) {
                install(ServerWebSockets)
                routing {
                    webSocket("/base/close") {
                        try {
                            send("ready")
                            for (frame in incoming) {
                                send(frame)
                            }
                        } finally {
                            closed.trySend(Unit)
                        }
                    }
                }
            }.startSuspend()
        val http = HttpClient(ClientCIO) { socketDefaults() }
        try {
            val port =
                server.engine
                    .resolvedConnectors()
                    .first()
                    .port
            val api = SocketApiClient(http, "ws://localhost:$port/base")
            withTimeout(20_000) { test(api, closed) }
        } finally {
            http.close()
            server.stopSuspend(0, 0)
            closed.close()
        }
    }
}
