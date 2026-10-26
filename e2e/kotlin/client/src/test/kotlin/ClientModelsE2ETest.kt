package com.example.clientmodels

import com.example.clientmodels.api.ApiException
import com.example.clientmodels.api.ForbiddenException
import com.example.clientmodels.client.ClientModelsApiClient
import com.example.clientmodels.client.ClientModelsAuth
import com.example.clientmodels.client.ClientModelsJson
import com.example.clientmodels.client.clientModelsDefaults
import com.example.clientmodels.models.Ambiguous
import com.example.clientmodels.models.Level
import com.example.clientmodels.models.Literal
import com.example.clientmodels.models.NullInfo
import com.example.clientmodels.models.OptionalValue
import com.example.clientmodels.models.Patch
import com.example.clientmodels.models.Permission
import com.example.clientmodels.models.Specific
import io.ktor.client.HttpClient
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.engine.embeddedServer
import io.ktor.server.request.receiveText
import io.ktor.server.response.respondBytes
import io.ktor.server.response.respondBytesWriter
import io.ktor.server.response.respondText
import io.ktor.server.response.respondTextWriter
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import io.ktor.server.testing.testApplication
import io.ktor.utils.io.readByte
import io.ktor.utils.io.toByteArray
import io.ktor.utils.io.writeByte
import io.ktor.utils.io.writeFully
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import io.ktor.client.engine.cio.CIO as ClientCIO
import io.ktor.server.cio.CIO as ServerCIO

class ClientModelsE2ETest {
    @Test
    fun optionalFieldsPreserveAbsentNullAndValuesWithBothJsonPolicies() {
        for (defaults in listOf(false, true)) {
            val json =
                Json(ClientModelsJson) {
                    encodeDefaults = defaults
                    explicitNulls = false
                }
            assertEquals("{}", json.encodeToString(Patch()))
            val cleared = Patch(label = OptionalValue.Present(null))
            assertEquals("""{"label":null}""", json.encodeToString(cleared))
            assertEquals(cleared, json.decodeFromString<Patch>("""{"label":null}"""))
            assertEquals(OptionalValue.Absent, json.decodeFromString<Patch>("{}").label)
            val withId = Patch(externalId = OptionalValue.Present(9007199254740993L))
            assertEquals("""{"external_id":"9007199254740993"}""", json.encodeToString(withId))
            assertEquals(withId, json.decodeFromString<Patch>(json.encodeToString(withId)))
        }
        assertFailsWith<IllegalArgumentException> { Patch(name = OptionalValue.Present("")) }
    }

    @Test
    fun untaggedUnionsRoundTripTheirOriginalWireShapesAndRejectAmbiguity() {
        val simple: Permission = Permission.Simple(Level.READ)
        assertEquals("\"Read\"", ClientModelsJson.encodeToString(simple))
        assertEquals(simple, ClientModelsJson.decodeFromString<Permission>("\"Read\""))
        val specific: Permission = Permission.Specific(Specific(Level.WRITE, listOf("deploy")))
        val encoded = ClientModelsJson.encodeToString(specific)
        assertEquals(Json.parseToJsonElement("""{"level":"Write","scopes":["deploy"]}"""), Json.parseToJsonElement(encoded))
        assertEquals(specific, ClientModelsJson.decodeFromString<Permission>(encoded))
        assertFailsWith<SerializationException> { ClientModelsJson.decodeFromString<Ambiguous>("{}") }
        assertFailsWith<SerializationException> { ClientModelsJson.decodeFromString<Permission>("false") }
        assertFailsWith<SerializationException> { ClientModelsJson.decodeFromString<Literal>("8") }
        assertEquals(Literal.Fixed(7), ClientModelsJson.decodeFromString<Literal>("7"))
        assertEquals(NullInfo(JsonNull), ClientModelsJson.decodeFromString<NullInfo>("""{"info":null}"""))
        assertFailsWith<SerializationException> { ClientModelsJson.decodeFromString<NullInfo>("""{"info":{}}""") }
    }

    @Test
    fun sharedTransportPreservesRequestBodiesCharsetsAndExplicitSerializers() =
        testApplication {
            application {
                routing {
                    post("/client/patch") { call.respondText(call.receiveText(), ContentType.Application.Json) }
                    get("/client/id") { call.respondText("\"9007199254740993\"", ContentType.Application.Json) }
                    get("/client/text") {
                        call.respondBytes(byteArrayOf(99, 97, 102, -23), ContentType.Text.Plain.withParameter("charset", "ISO-8859-1"))
                    }
                    get("/client/choice") { call.respondText("{\"level\":\"Read\",\"scopes\":[]}", ContentType.Application.Json) }
                }
            }
            val api = ClientModelsApiClient(createClient { clientModelsDefaults() }, "")
            val patch = Patch(label = OptionalValue.Present(null), externalId = OptionalValue.Present(42L))
            assertEquals(patch, api.operations.patch(patch))
            assertEquals(9007199254740993L, api.operations.id())
            assertEquals("café", api.operations.text())
            assertIs<com.example.clientmodels.api.ChoiceResult.Ok>(api.operations.choice())
        }

    @Test
    fun rawBytesAndRotatingCredentialsUseTheSharedTransport() =
        testApplication {
            var token = "first"
            val bytes = byteArrayOf(0, -1, 1, -128)
            application {
                routing {
                    get("/client/binary") {
                        assertEquals("Bearer $token", call.request.headers["Authorization"])
                        call.respondBytes(bytes, ContentType.Application.OctetStream)
                    }
                }
            }
            val http = createClient { clientModelsDefaults() }
            val api = ClientModelsApiClient(http, "", ClientModelsAuth(bearerAuth = { token }))
            assertContentEquals(bytes, api.operations.binary())
            token = "second"
            assertContentEquals(bytes, api.operations.binary())
        }

    @Test
    fun streamingDeliversBeforeCompletionAndReleasesOnCancellation() =
        runBlocking {
            val release = CompletableDeferred<Unit>()
            val stopped = CompletableDeferred<Unit>()
            val server =
                embeddedServer(ServerCIO, port = 0) {
                    routing {
                        get("/client/binary") {
                            call.respondBytesWriter(ContentType.Application.OctetStream) {
                                writeByte(42)
                                flush()
                                release.await()
                                writeFully(ByteArray(256) { 7 })
                            }
                        }
                        get("/client/endless") {
                            call.respondBytesWriter(ContentType.Application.OctetStream) {
                                try {
                                    while (true) {
                                        writeByte(1)
                                        flush()
                                        delay(10)
                                    }
                                } finally {
                                    stopped.complete(Unit)
                                }
                            }
                        }
                    }
                }.startSuspend()
            val http = HttpClient(ClientCIO) { clientModelsDefaults() }
            try {
                val port =
                    server.engine
                        .resolvedConnectors()
                        .first()
                        .port
                val api = ClientModelsApiClient(http, "http://localhost:$port")
                withTimeout(20_000) {
                    api.operations.binaryStream { channel ->
                        assertEquals(42, channel.readByte().toInt())
                        release.complete(Unit)
                        assertEquals(256, channel.toByteArray().size)
                    }
                    assertFailsWith<CancellationException> {
                        api.operations.endlessStream { channel ->
                            channel.readByte()
                            throw CancellationException("consumer cancelled")
                        }
                    }
                    stopped.await()
                }
            } finally {
                release.complete(Unit)
                http.close()
                server.stopSuspend(0, 0)
            }
        }

    @Test
    fun successAndChunkedErrorLimitsRetainStatusAndTypedErrorsStillDecode() =
        testApplication {
            var oversized = true
            application {
                routing {
                    get("/client/large") { call.respondText("""{"value":"${"x".repeat(256)}"}""", ContentType.Application.Json) }
                    get("/client/denied") {
                        call.response.status(HttpStatusCode.Forbidden)
                        call.respondTextWriter(ContentType.Application.Json) {
                            write(if (oversized) "x".repeat(256) else """{"message":"denied"}""")
                        }
                    }
                }
            }
            val api = ClientModelsApiClient(createClient { clientModelsDefaults() }, "")
            assertEquals(200, assertFailsWith<ApiException> { api.operations.large() }.status)
            assertEquals(403, assertFailsWith<ApiException> { api.operations.denied() }.status)
            oversized = false
            assertEquals("denied", assertFailsWith<ForbiddenException> { api.operations.denied() }.error.message)
        }
}
