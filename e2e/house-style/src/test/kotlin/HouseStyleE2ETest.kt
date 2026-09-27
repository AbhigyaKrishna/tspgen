import com.example.core.ForbiddenException
import com.example.core.JWT_AUTH
import com.example.core.NotFoundException
import com.example.core.Page
import com.example.graph.CreateNodeRequest
import com.example.graph.GraphModule
import com.example.graph.GraphService
import com.example.graph.Node
import com.example.graph.NodeKind
import com.example.models.ProbeResponse
import com.example.server.serverJson
import com.example.server.shopErrors
import io.ktor.client.call.body
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.install
import io.ktor.server.auth.Authentication
import io.ktor.server.auth.UserIdPrincipal
import io.ktor.server.auth.bearer
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.response.respond
import io.ktor.server.routing.routing
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation as ClientContentNegotiation

class HouseStyleE2ETest {
    private fun ApplicationTestBuilder.serve(service: GraphService) {
        application {
            // No generated module (features.module: false): the application installs the generated serverJson itself.
            install(ContentNegotiation) { json(serverJson) }
            install(Authentication) {
                bearer(JWT_AUTH) { authenticate { credential -> UserIdPrincipal(credential.token) } }
            }
            install(StatusPages) {
                shopErrors()
                exception<NotFoundException> { call, cause -> call.respond(HttpStatusCode.NotFound, cause.message ?: "") }
                exception<ForbiddenException> { call, _ -> call.respond(HttpStatusCode.Forbidden) }
            }
            routing {
                with(GraphModule) {
                    mount(service)
                    mountUnmanaged(service)
                }
            }
        }
    }

    private fun ApplicationTestBuilder.clientFor(user: String?, vararg permissions: String) = createClient {
        install(ClientContentNegotiation) { json() }
        defaultRequest {
            if (user != null) bearerAuth(user)
            header("X-Permissions", permissions.joinToString(","))
        }
    }

    private suspend fun io.ktor.client.HttpClient.create(name: String, kind: NodeKind) =
        post("/graph/nodes") {
            contentType(ContentType.Application.Json)
            setBody(CreateNodeRequest(name = name, kind = kind))
        }

    @Test
    fun `creates, pages, filters and reads nodes with the caller as actor`() = testApplication {
        val service = GraphService()
        serve(service)
        val client = clientFor("alice", "graph:read", "graph:write")

        val created = client.create("primary-db", NodeKind.DATABASE)
        assertEquals(HttpStatusCode.Created, created.status)
        val db = created.body<Node>()
        client.create("events", NodeKind.QUEUE)

        val second = client.get("/graph/nodes?offset=1&limit=1").body<Page<Node>>()
        assertEquals(2L, second.total)
        assertEquals(listOf("events"), second.items.map { it.name })
        assertEquals(listOf("primary-db"), client.get("/graph/nodes?kind=DATABASE").body<Page<Node>>().items.map { it.name })
        assertEquals(db, client.get("/graph/nodes/${db.id}").body<Node>())
        // serverJson's encode-defaults: false leaves unset optionals out instead of writing null.
        val raw = client.get("/graph/nodes/${db.id}").bodyAsText()
        assertFalse("description" in raw || "null" in raw, raw)
        assertEquals(listOf("alice", "alice"), service.actors)
    }

    @Test
    fun `deletes nodes and reports missing ones`() = testApplication {
        serve(GraphService())
        val client = clientFor("bob", "graph:read", "graph:write")
        val node = client.create("cache", NodeKind.DATABASE).body<Node>()
        assertEquals(HttpStatusCode.NoContent, client.delete("/graph/nodes/${node.id}").status)
        assertEquals(HttpStatusCode.NotFound, client.get("/graph/nodes/${node.id}").status)
    }

    @Test
    fun `read permission does not grant write`() = testApplication {
        serve(GraphService())
        val reader = clientFor("carol", "graph:read")
        assertEquals(HttpStatusCode.OK, reader.get("/graph/nodes").status)
        assertEquals(HttpStatusCode.Forbidden, reader.create("nope", NodeKind.QUEUE).status)
    }

    @Test
    fun `unauthenticated requests are rejected`() = testApplication {
        serve(GraphService())
        assertEquals(HttpStatusCode.Unauthorized, clientFor(null).get("/graph/nodes").status)
    }

    @Test
    fun `generated validation rejects a blank name`() = testApplication {
        serve(GraphService())
        val response = clientFor("dave", "graph:write").post("/graph/nodes") {
            contentType(ContentType.Application.Json)
            setBody("""{"name":" ","kind":"DATABASE"}""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals(
            """{"type":"about:blank","title":"Bad Request","status":400,"detail":"name must not be blank"}""",
            response.bodyAsText(),
        )
    }

    @Test
    fun `the unmanaged route set is mounted separately`() = testApplication {
        serve(GraphService())
        val response = clientFor("erin", "graph:write").post("/graph/probe")
        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals(ProbeResponse(ok = true), response.body<ProbeResponse>())
    }
}
