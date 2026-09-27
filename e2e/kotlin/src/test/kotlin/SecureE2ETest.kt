package com.example.petstore

import com.example.petstore.api.ApiException
import com.example.petstore.client.SecureStoreApiClient
import com.example.petstore.client.secureStoreDefaults
import com.example.petstore.models.Greeting
import com.example.petstore.server.LobbyService
import com.example.petstore.server.PartnerService
import com.example.petstore.server.SecureService
import com.example.petstore.server.secureStoreModule
import io.ktor.client.HttpClient
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.header
import io.ktor.client.request.request
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.auth.Authentication
import io.ktor.server.auth.AuthenticationFailedCause
import io.ktor.server.auth.UserIdPrincipal
import io.ktor.server.auth.bearer
import io.ktor.server.response.respond
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import com.example.petstore.server.ItemsService as DslItems
import com.example.secure.nest.models.Greeting as NestGreeting
import com.example.secure.nest.server.ItemsService as NestItems
import com.example.secure.nest.server.LobbyService as NestLobby
import com.example.secure.nest.server.PartnerService as NestPartner
import com.example.secure.nest.server.SecureService as NestSecure
import com.example.secure.nest.server.secureStoreModule as nestModule
import com.example.secure.resources.models.Greeting as ResGreeting
import com.example.secure.resources.server.ItemsService as ResItems
import com.example.secure.resources.server.LobbyService as ResLobby
import com.example.secure.resources.server.PartnerService as ResPartner
import com.example.secure.resources.server.SecureService as ResSecure
import com.example.secure.resources.server.secureStoreModule as resourcesModule

class Greetings : SecureService {
    override suspend fun secret() = Greeting("secret")
    override suspend fun open() = Greeting("public")
    override suspend fun optional() = Greeting("optional")
    override suspend fun either() = Greeting("either")
    override suspend fun both() = Greeting("both")
}

class PartnerGreetings : PartnerService {
    override suspend fun list() = Greeting("partner")
    override suspend fun bearer() = Greeting("partner-bearer")
}

class LobbyGreetings : LobbyService {
    override suspend fun index() = Greeting("lobby")
    override suspend fun members() = Greeting("members")
}

class ItemGreetings : DslItems {
    override suspend fun list() = Greeting("items")
    override suspend fun create() = Greeting("created")
    override suspend fun purge() = Greeting("purged")
}

/** Bearer "secret" as BearerAuth; header X-Partner: partner as PartnerKey, mapped to PARTNER_PROVIDER via auth-providers. */
fun Application.installSecureAuth() {
    install(Authentication) {
        bearer("BearerAuth") {
            authenticate { credential -> if (credential.token == "secret") UserIdPrincipal("tester") else null }
        }
        provider(PARTNER_PROVIDER) {
            authenticate { context ->
                val key = context.call.request.headers["X-Partner"]
                if (key == "partner") {
                    context.principal(UserIdPrincipal("partner"))
                } else {
                    val cause = if (key == null) AuthenticationFailedCause.NoCredentials else AuthenticationFailedCause.InvalidCredentials
                    context.challenge("PartnerKey", cause) { challenge, call ->
                        call.respond(HttpStatusCode.Unauthorized)
                        challenge.complete()
                    }
                }
            }
        }
    }
}

/** Credentials a request sends: bearer token and/or partner key (null: not sent). */
data class Creds(val bearer: String? = null, val partner: String? = null) {
    override fun toString() =
        listOfNotNull(bearer?.let { "bearer=$it" }, partner?.let { "partner=$it" }).joinToString().ifEmpty { "anonymous" }
}

private val ANONYMOUS = Creds()
private val BEARER = Creds(bearer = "secret")
private val BAD_BEARER = Creds(bearer = "wrong")
private val PARTNER = Creds(partner = "partner")
private val BAD_PARTNER = Creds(partner = "wrong")
private val BOTH = Creds(bearer = "secret", partner = "partner")

/** Expected status per route and credentials: the same for every routing mode. */
private val MATRIX: List<Triple<Pair<HttpMethod, String>, Creds, Int>> = buildList {
    fun expect(method: HttpMethod, path: String, vararg cases: Pair<Creds, Int>) =
        cases.forEach { (creds, status) -> add(Triple(method to path, creds, status)) }
    val get = HttpMethod.Get
    // Service-level BearerAuth.
    expect(get, "/secure/secret", BEARER to 200, ANONYMOUS to 401, BAD_BEARER to 401, PARTNER to 401)
    // NoAuth.
    expect(get, "/secure/public", ANONYMOUS to 200, BAD_BEARER to 200)
    // BearerAuth | NoAuth: a bad token is still rejected.
    expect(get, "/secure/optional", ANONYMOUS to 200, BEARER to 200, BAD_BEARER to 401)
    // BearerAuth | PartnerKey: either, but a bad partner key (no token) is not enough.
    expect(get, "/secure/either", BEARER to 200, PARTNER to 200, ANONYMOUS to 401, BAD_PARTNER to 401, BAD_BEARER to 401)
    // [BearerAuth, PartnerKey]: both.
    expect(get, "/secure/both", BOTH to 200, BEARER to 401, PARTNER to 401, Creds("secret", "wrong") to 401)
    // Interface-level PartnerKey overrides the service's BearerAuth; the operation's own BearerAuth wins over it.
    expect(get, "/partner", PARTNER to 200, BEARER to 401, ANONYMOUS to 401)
    expect(get, "/partner/bearer", BEARER to 200, PARTNER to 401)
    // NoAuth interface with one authenticated operation.
    expect(get, "/lobby", ANONYMOUS to 200)
    expect(get, "/lobby/members", BEARER to 200, ANONYMOUS to 401)
    // One path, a different requirement per method.
    expect(get, "/items", ANONYMOUS to 200)
    expect(HttpMethod.Post, "/items", BEARER to 200, ANONYMOUS to 401, PARTNER to 401)
    expect(HttpMethod.Delete, "/items", BOTH to 200, BEARER to 401, PARTNER to 401)
}

private suspend fun HttpClient.checkMatrix(mode: String) {
    val failures = MATRIX.mapNotNull { (route, creds, expected) ->
        val (method, path) = route
        val status = request(path) {
            this.method = method
            creds.bearer?.let { bearerAuth(it) }
            creds.partner?.let { header("X-Partner", it) }
        }.status.value
        if (status == expected) null else "$mode: ${method.value} $path [$creds] -> $status, expected $expected"
    }
    assertEquals(emptyList(), failures)
}

/** Routes wrapped in authenticate(...) generated from @useAuth; the provider is named after the scheme id. */
class SecureE2ETest {
    @Test
    fun useAuthDrivesAuthenticateWrappers() = testApplication {
        application {
            installSecureAuth()
            secureStoreModule(Greetings(), PartnerGreetings(), LobbyGreetings(), ItemGreetings())
        }
        fun api(token: String?, partner: String? = null) = SecureStoreApiClient(
            createClient {
                secureStoreDefaults()
                defaultRequest {
                    if (token != null) bearerAuth(token)
                    if (partner != null) header("X-Partner", partner)
                }
            },
            "http://localhost",
        )
        val authed = api("secret")
        val anonymous = api(null)
        val wrong = api("wrong")

        // BearerAuth (service level): 401 without or with a bad token, 200 with a valid one.
        assertEquals(Greeting("secret"), authed.secure.secret())
        assertEquals(401, assertFailsWith<ApiException> { anonymous.secure.secret() }.status)
        assertEquals(401, assertFailsWith<ApiException> { wrong.secure.secret() }.status)

        // NoAuth: public for everyone.
        assertEquals(Greeting("public"), anonymous.secure.open())
        assertEquals(Greeting("public"), wrong.secure.open())

        // BearerAuth | NoAuth: anonymous or a valid token; a bad token is still rejected.
        assertEquals(Greeting("optional"), anonymous.secure.optional())
        assertEquals(Greeting("optional"), authed.secure.optional())
        assertEquals(401, assertFailsWith<ApiException> { wrong.secure.optional() }.status)

        // BearerAuth | PartnerKey: either credential; a bad partner key without a token is rejected.
        val partner = api(null, "partner")
        val both = api("secret", "partner")
        assertEquals(Greeting("either"), authed.secure.either())
        assertEquals(Greeting("either"), partner.secure.either())
        assertEquals(401, assertFailsWith<ApiException> { anonymous.secure.either() }.status)
        assertEquals(401, assertFailsWith<ApiException> { api(null, "wrong").secure.either() }.status)

        // [BearerAuth, PartnerKey]: both credentials.
        assertEquals(Greeting("both"), both.secure.both())
        assertEquals(401, assertFailsWith<ApiException> { authed.secure.both() }.status)
        assertEquals(401, assertFailsWith<ApiException> { partner.secure.both() }.status)

        // Interface-level and operation-level overrides, one path with per-method auth.
        assertEquals(Greeting("partner"), partner.partner.list())
        assertEquals(Greeting("members"), authed.lobby.members())
        assertEquals(Greeting("items"), anonymous.items.list())
        assertEquals(Greeting("purged"), both.items.purge())
        assertEquals(401, assertFailsWith<ApiException> { authed.items.purge() }.status)
    }

    @Test
    fun dslRoutingAuthMatrix() = testApplication {
        application {
            installSecureAuth()
            secureStoreModule(Greetings(), PartnerGreetings(), LobbyGreetings(), ItemGreetings())
        }
        client.checkMatrix("dsl")
    }

    @Test
    fun resourcesRoutingAuthMatrix() = testApplication {
        application {
            installSecureAuth()
            resourcesModule(
                object : ResSecure {
                    override suspend fun secret() = ResGreeting("secret")
                    override suspend fun open() = ResGreeting("public")
                    override suspend fun optional() = ResGreeting("optional")
                    override suspend fun either() = ResGreeting("either")
                    override suspend fun both() = ResGreeting("both")
                },
                object : ResPartner {
                    override suspend fun list() = ResGreeting("partner")
                    override suspend fun bearer() = ResGreeting("partner-bearer")
                },
                object : ResLobby {
                    override suspend fun index() = ResGreeting("lobby")
                    override suspend fun members() = ResGreeting("members")
                },
                object : ResItems {
                    override suspend fun list() = ResGreeting("items")
                    override suspend fun create() = ResGreeting("created")
                    override suspend fun purge() = ResGreeting("purged")
                },
            )
        }
        client.checkMatrix("resources")
    }

    @Test
    fun nestedRoutesAuthMatrix() = testApplication {
        application {
            installSecureAuth()
            nestModule(
                object : NestSecure {
                    override suspend fun secret() = NestGreeting("secret")
                    override suspend fun open() = NestGreeting("public")
                    override suspend fun optional() = NestGreeting("optional")
                    override suspend fun either() = NestGreeting("either")
                    override suspend fun both() = NestGreeting("both")
                },
                object : NestPartner {
                    override suspend fun list() = NestGreeting("partner")
                    override suspend fun bearer() = NestGreeting("partner-bearer")
                },
                object : NestLobby {
                    override suspend fun index() = NestGreeting("lobby")
                    override suspend fun members() = NestGreeting("members")
                },
                object : NestItems {
                    override suspend fun list() = NestGreeting("items")
                    override suspend fun create() = NestGreeting("created")
                    override suspend fun purge() = NestGreeting("purged")
                },
            )
        }
        client.checkMatrix("nest-routes")
    }
}
