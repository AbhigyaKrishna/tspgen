package com.example.faults

import com.example.faults.api.ApiException
import com.example.faults.api.FaultException
import com.example.faults.models.Fault
import com.example.faults.models.Item
import com.example.faults.models.NoteForm
import com.example.faults.server.ItemsService
import com.example.faults.server.ServerErrorKind
import com.example.faults.server.faultsErrors
import com.example.faults.server.itemsRoutes
import com.example.faults.server.serverErrorOf
import com.example.faults.server.serverJson
import io.ktor.client.request.forms.MultiPartFormDataContent
import io.ktor.client.request.forms.formData
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.install
import io.ktor.server.plugins.BadRequestException
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.response.respond
import io.ktor.server.routing.routing
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.serialization.Serializable
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The application's own error format, built from ServerError. */
@Serializable
data class Envelope(val status: Int, val code: String, val message: String?)

class FaultyItems : ItemsService {
    override suspend fun get(id: Long): Item = when (id) {
        0L -> throw ApiException(418, "teapot")
        1L -> throw FaultException(Fault("gone"), 410)
        else -> Item("a", null)
    }

    override suspend fun search(q: String): List<Item> = listOf(Item(q, null))

    override suspend fun create(item: Item): Item = item

    override suspend fun note(body: NoteForm): Item = Item(body.title, null)
}

class ErrorsE2ETest {
    private fun app(block: suspend ApplicationTestBuilder.() -> Unit) = testApplication {
        application {
            install(ContentNegotiation) { json(serverJson) }
            install(StatusPages) {
                faultsErrors { error -> respond(error.status, Envelope(error.status.value, error.kind.name, error.detail)) }
            }
            routing { itemsRoutes(FaultyItems()) }
        }
        block()
    }

    private suspend fun HttpResponse.envelope(): Envelope = serverJson.decodeFromString(Envelope.serializer(), bodyAsText())

    @Test
    fun everyKindReachesTheResponder() = app {
        suspend fun expect(response: HttpResponse, status: Int, kind: ServerErrorKind, detail: String?) {
            assertEquals(Envelope(status, kind.name, detail), response.envelope(), response.bodyAsText())
        }
        expect(client.get("/items"), 400, ServerErrorKind.MissingParameter, "Request parameter q is missing")
        expect(
            client.get("/items/abc"),
            400, ServerErrorKind.InvalidParameter, "Request parameter id couldn't be parsed/converted to value",
        )
        expect(
            client.post("/items") { contentType(ContentType.Application.Json); setBody("""{}""") },
            400, ServerErrorKind.MalformedBody, "Malformed request body: missing 'name'",
        )
        expect(
            client.post("/items") { contentType(ContentType.Application.Json); setBody("""{"name":" "}""") },
            400, ServerErrorKind.FailedCheck, "name must not be blank",
        )
        // BigDecimal's own IllegalArgumentException (a NumberFormatException) is no model check, and echoes the input.
        val badDecimal = client.post("/items") { contentType(ContentType.Application.Json); setBody("""{"name":"a","price":"abc"}""") }
        assertEquals(400, badDecimal.status.value)
        val decimal = badDecimal.envelope()
        assertEquals(ServerErrorKind.MalformedBody.name, decimal.code, decimal.toString())
        val detail = decimal.message.orEmpty()
        assertTrue(detail.startsWith("Malformed request body"), detail)
        assertFalse("abc" in detail || "decimal digit" in detail, detail)
        expect(
            client.post("/items/notes") { setBody(MultiPartFormDataContent(formData { append("title", "a"); append("title", "b") })) },
            400, ServerErrorKind.MalformedBody, "Part 'title' must be sent at most once",
        )
        val tooBig = client.post("/items/notes") { setBody(MultiPartFormDataContent(formData { append("title", "x".repeat(100)) })) }
        assertEquals(413, tooBig.status.value)
        assertEquals(ServerErrorKind.PayloadTooLarge.name, tooBig.envelope().code)
        expect(
            client.post("/items") { contentType(ContentType.Text.Plain); setBody("x") },
            415, ServerErrorKind.UnsupportedMediaType, "Content type text/plain; charset=UTF-8 is not supported",
        )
        expect(client.get("/items/0"), 418, ServerErrorKind.ApiException, "teapot")
    }

    @Test
    fun declaredBodiesSkipTheResponder() = app {
        val response = client.get("/items/1")
        assertEquals(HttpStatusCode.Gone, response.status)
        assertEquals("""{"code":"gone"}""", response.bodyAsText())
    }

    @Test
    fun serverErrorOfClassifiesInAHandWrittenStatusPages() = testApplication {
        application {
            install(ContentNegotiation) { json(serverJson) }
            install(StatusPages) {
                exception<BadRequestException> { call, cause ->
                    val error = call.serverErrorOf(cause)!!
                    call.respond(error.status, "${error.kind}: ${error.detail}")
                }
            }
            routing { itemsRoutes(FaultyItems()) }
        }
        assertEquals("MissingParameter: Request parameter q is missing", client.get("/items").bodyAsText())
    }

    @Test
    fun explicitNullsOffOmitsAndAcceptsAbsentNulls() = app {
        assertEquals("""{"name":"a"}""", client.get("/items/5").bodyAsText())
        val created = client.post("/items") { contentType(ContentType.Application.Json); setBody("""{"name":"b"}""") }
        assertEquals(HttpStatusCode.OK, created.status, created.bodyAsText())
        assertEquals("""{"name":"b"}""", created.bodyAsText())
    }
}
