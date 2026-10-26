package com.example.ledger

import com.example.ledger.api.SinceResult
import com.example.ledger.client.LedgerApiClient
import com.example.ledger.client.ledgerDefaults
import com.example.ledger.models.Account
import com.example.ledger.models.AccountId
import com.example.ledger.models.BatchId
import com.example.ledger.models.EntryEvents
import com.example.ledger.models.EntryForm
import com.example.ledger.models.Currency
import com.example.ledger.models.SeenAt
import com.example.ledger.models.Status
import com.example.ledger.models.Tier
import com.example.ledger.models.modelSerializersModule
import com.example.ledger.server.AccountsService
import com.example.ledger.server.EntriesService
import com.example.ledger.server.ledgerModule
import com.example.ledgersearch.models.Hit
import com.example.ledgersearch.server.SearchService
import com.example.ledgersearch.server.ledgerSearchModule
import io.ktor.client.request.forms.MultiPartFormDataContent
import io.ktor.client.request.forms.formData
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import io.ktor.server.testing.testApplication
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import java.math.BigDecimal
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

private val account = Account(
    id = AccountId(42),
    balance = BigDecimal("12.50"),
    currency = Currency("EUR"),
    sequence = 7,
    holds = listOf(AccountId(1), AccountId(2)),
    status = Status.OPEN,
    tier = Tier.GOLD,
    limit = ULong.MAX_VALUE,
    visits = 3u,
)

class Accounts : AccountsService {
    override suspend fun get(id: AccountId): Account = account.copy(id = id)

    override suspend fun create(account: Account): Account = account

    override suspend fun search(min: BigDecimal, currency: Currency): List<Account> =
        listOf(account.copy(balance = min, currency = currency))

    override suspend fun since(id: AccountId, seenAfter: SeenAt?): SinceResult =
        SinceResult.Ok(account.copy(id = id), seenAfter ?: SeenAt(Instant.parse("2026-01-01T00:00:00Z")))
}

/** Beyond 2^53: a JavaScript number would round it, so it must travel as a string. */
private const val BIG = 9007199254740993L

class Entries : EntriesService {
    override suspend fun list(): List<Long> = listOf(BIG, 1)

    override suspend fun one(): Long = BIG

    override suspend fun take(ids: List<Long>): List<Long> = ids.reversed()

    override suspend fun batch(ids: List<BatchId>): BatchId = ids.sum()

    override suspend fun feed(): Flow<EntryEvents> = flowOf(EntryEvents.Ids(listOf(BIG, 2)))

    override suspend fun form(body: EntryForm): List<Long> = body.ids + body.note.length.toLong()
}

/** BigDecimal, string-encoded Long/ULong, value classes and enum-unknown through the generated server and client. */
class MappingE2ETest {
    private val json = Json { serializersModule = modelSerializersModule }

    @Test
    fun roundTripsThroughServerAndClient() = testApplication {
        application { ledgerModule(Accounts(), Entries()) }
        val api = LedgerApiClient(createClient { ledgerDefaults() }, "http://localhost")
        assertEquals(account, api.accounts.create(account))
        assertEquals(account.copy(id = AccountId(9)), api.accounts.get(AccountId(9)))
        assertEquals(
            listOf(account.copy(balance = BigDecimal("10.5"), currency = Currency("USD"))),
            api.accounts.search(BigDecimal("10.5"), Currency("USD")),
        )
    }

    /** The JSON the TypeScript mapping e2e replays to its clients. */
    @Test
    fun writesTheSpecifiedWireFormat() = testApplication {
        application { ledgerModule(Accounts(), Entries()) }
        val body = client.get("/accounts/42").bodyAsText()
        for (expected in listOf(
            """"id":"42"""",
            """"balance":"12.50"""",
            """"currency":"EUR"""",
            """"sequence":"7"""",
            """"holds":["1","2"]""",
            """"limit":"18446744073709551615"""",
            """"visits":3""",
        )) {
            assertTrue(body.contains(expected), "$expected in $body")
        }
    }

    @Test
    fun readsDecimalNumbersAndUnknownTiers() {
        val wire = """{"id":"1","balance":12.5,"currency":"EUR","sequence":"1","holds":[],"status":"open","tier":"platinum","visits":0}"""
        val decoded = json.decodeFromString<Account>(wire)
        assertEquals(BigDecimal("12.5"), decoded.balance)
        assertEquals(Tier.UNKNOWN, decoded.tier)
        assertFailsWith<SerializationException> { json.encodeToString(decoded) }
    }

    @Test
    fun valueClassesCheckTheirScalarConstraints() {
        assertFailsWith<IllegalArgumentException> { Currency("E") }
    }

    /** AccountId as a path param, SeenAt (a java.time-based value class) as a query param and response header. */
    @Test
    fun valueClassPathQueryAndHeaderRoundTrip() = testApplication {
        application { ledgerModule(Accounts(), Entries()) }
        val api = LedgerApiClient(createClient { ledgerDefaults() }, "http://localhost")
        val seenAfter = SeenAt(Instant.parse("2026-02-01T00:00:00Z"))

        val withQuery = api.accounts.since(AccountId(7), seenAfter) as SinceResult.Ok
        assertEquals(account.copy(id = AccountId(7)), withQuery.body)
        assertEquals(seenAfter, withQuery.seenAt)

        val withoutQuery = api.accounts.since(AccountId(5), null) as SinceResult.Ok
        assertEquals(SeenAt(Instant.parse("2026-01-01T00:00:00Z")), withoutQuery.seenAt)

        // typespec-http lower-cases and hyphenates the default header name for a camelCase property.
        val raw = client.get("/accounts/7/since?seenAfter=2026-02-01T00:00:00Z")
        assertEquals("2026-02-01T00:00:00Z", raw.headers["seen-at"])
    }
}

/** @encode(string) int64 as whole bodies, event payloads and multipart JSON parts (inline and typealias scalars). */
class TopLevelEncodingE2ETest {
    @Test
    fun serverWritesAndReadsStrings() = testApplication {
        application { ledgerModule(Accounts(), Entries()) }
        assertEquals("""["9007199254740993","1"]""", client.get("/entries").bodyAsText())
        assertEquals("\"9007199254740993\"", client.get("/entries/one").bodyAsText())
        val taken = client.post("/entries") {
            contentType(ContentType.Application.Json)
            setBody("""["1","9007199254740993"]""")
        }
        assertEquals("""["9007199254740993","1"]""", taken.bodyAsText())
        val batch = client.post("/entries/batch") {
            contentType(ContentType.Application.Json)
            setBody("""["2","3"]""")
        }
        assertEquals("\"5\"", batch.bodyAsText())
        // Ktor's DefaultJson (under serverJson) is lenient: numbers are read too. Malformed JSON is a 400 problem.
        val lenient = client.post("/entries") {
            contentType(ContentType.Application.Json)
            setBody("[1]")
        }
        assertEquals("""["1"]""", lenient.bodyAsText())
        val malformed = client.post("/entries") {
            contentType(ContentType.Application.Json)
            setBody("[")
        }
        assertEquals(400, malformed.status.value)
        assertEquals(ContentType.Application.ProblemJson, malformed.contentType()?.withoutParameters(), malformed.bodyAsText())
        val text = client.post("/entries") {
            contentType(ContentType.Text.Plain)
            setBody("1")
        }
        assertEquals(415, text.status.value)
        assertTrue(client.get("/entries/feed").bodyAsText().contains("""data: ["9007199254740993","2"]"""))
        val form = client.post("/entries/form") {
            setBody(MultiPartFormDataContent(formData {
                append("ids", """["9007199254740993"]""", Headers.build { append(HttpHeaders.ContentType, "application/json") })
                append("note", "abc")
            }))
        }
        assertEquals("""["9007199254740993","3"]""", form.bodyAsText())
    }

    @Test
    fun clientRoundTripsThroughTheServer() = testApplication {
        application { ledgerModule(Accounts(), Entries()) }
        val api = LedgerApiClient(createClient { ledgerDefaults() }, "http://localhost")
        assertEquals(listOf(BIG, 1L), api.entries.list())
        assertEquals(BIG, api.entries.one())
        assertEquals(listOf(2L, BIG), api.entries.take(listOf(BIG, 2)))
        assertEquals(10L, api.entries.batch(listOf(4, 6)))
        assertEquals(listOf(EntryEvents.Ids(listOf(BIG, 2))), api.entries.feed().toList())
        assertEquals(listOf(BIG, 2L), api.entries.form(EntryForm(ids = listOf(BIG), note = "hi")))
    }
}

private class LedgerSearchService : SearchService {
    override suspend fun find(min: BigDecimal, at: Instant?): List<Hit> = listOf(Hit(min))
}

/** routing-style: resources with a BigDecimal (and java.time) query parameter. */
class MappingResourcesE2ETest {
    @Test
    fun resourcesRoutingHandlesBigDecimalAndInstantQueryParams() = testApplication {
        application { ledgerSearchModule(LedgerSearchService()) }
        val body = client.get("/search?min=12.50&at=2026-01-01T00:00:00Z").bodyAsText()
        assertTrue(body.contains(""""amount":"12.50""""), body)
    }
}
