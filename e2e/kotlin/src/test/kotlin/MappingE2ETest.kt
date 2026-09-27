package com.example.ledger

import com.example.ledger.api.SinceResult
import com.example.ledger.client.LedgerApiClient
import com.example.ledger.client.ledgerDefaults
import com.example.ledger.models.Account
import com.example.ledger.models.AccountId
import com.example.ledger.models.Currency
import com.example.ledger.models.SeenAt
import com.example.ledger.models.Status
import com.example.ledger.models.Tier
import com.example.ledger.models.modelSerializersModule
import com.example.ledger.server.AccountsService
import com.example.ledger.server.ledgerModule
import com.example.ledgersearch.models.Hit
import com.example.ledgersearch.server.SearchService
import com.example.ledgersearch.server.ledgerSearchModule
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
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

/** BigDecimal, string-encoded Long/ULong, value classes and enum-unknown through the generated server and client. */
class MappingE2ETest {
    private val json = Json { serializersModule = modelSerializersModule }

    @Test
    fun roundTripsThroughServerAndClient() = testApplication {
        application { ledgerModule(Accounts()) }
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
        application { ledgerModule(Accounts()) }
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
        application { ledgerModule(Accounts()) }
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
