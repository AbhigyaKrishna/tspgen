import com.example.faults.none.api.ApiException
import com.example.faults.none.api.FaultException
import com.example.faults.none.models.Fault
import com.example.faults.none.models.Item
import com.example.faults.none.models.NoteForm
import com.example.faults.none.server.ItemsService
import com.example.faults.none.server.faultsErrors
import com.example.faults.none.server.itemsRoutes
import com.example.faults.none.server.serverJson
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.install
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.routing.routing
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals

/** `error-body: none` on the Ktor server target: the default responder answers status-only, with an empty body. */
class NoneFaultyItems : ItemsService {
    override suspend fun get(id: Long): Item = when (id) {
        0L -> throw ApiException(418, "teapot")
        1L -> throw FaultException(Fault("gone"), 410)
        else -> Item("a", null)
    }

    override suspend fun search(q: String): List<Item> = listOf(Item(q, null))

    override suspend fun create(item: Item): Item = item

    override suspend fun note(body: NoteForm): Item = Item(body.title, null)
}

class ErrorsNoneE2ETest {
    private fun app(block: suspend ApplicationTestBuilder.() -> Unit) = testApplication {
        application {
            install(ContentNegotiation) { json(serverJson) }
            install(StatusPages) { faultsErrors() }
            routing { itemsRoutes(NoneFaultyItems()) }
        }
        block()
    }

    @Test
    fun missingQueryParamAnswersEmpty400() = app {
        val response = client.get("/items")
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals("", response.bodyAsText())
    }

    @Test
    fun unsupportedContentTypeAnswersEmpty415() = app {
        val response = client.post("/items") {
            contentType(ContentType.Text.Plain)
            setBody("x")
        }
        assertEquals(HttpStatusCode.UnsupportedMediaType, response.status)
        assertEquals("", response.bodyAsText())
    }

    @Test
    fun unmappedApiExceptionAnswersEmpty418() = app {
        val response = client.get("/items/0")
        assertEquals(418, response.status.value)
        assertEquals("", response.bodyAsText())
    }

    @Test
    fun declaredBodyStillAnswersItsBody() = app {
        val response = client.get("/items/1")
        assertEquals(HttpStatusCode.Gone, response.status)
        assertEquals("""{"code":"gone"}""", response.bodyAsText())
    }
}
