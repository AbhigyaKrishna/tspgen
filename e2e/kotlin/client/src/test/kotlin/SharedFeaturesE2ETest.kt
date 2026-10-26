package com.example.shared

import com.example.shared.api.NotFoundException
import com.example.shared.client.PetStoreApiClient
import com.example.shared.client.petStoreDefaults
import com.example.shared.models.Ball
import com.example.shared.models.Binding
import com.example.shared.models.Kite
import com.example.shared.models.Page
import com.example.shared.models.Pet
import com.example.shared.models.Species
import com.example.shared.models.Tags
import com.example.shared.server.petStoreModule
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.server.testing.testApplication
import java.math.BigDecimal
import java.time.Instant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/** The same e2e/spec/features.tsp contract exercised by Go and TypeScript. */
class SharedFeaturesE2ETest {
    @Test
    fun roundTripsModelsPagesAndTypedErrors() = testApplication {
        application { petStoreModule(SharedPets(), SharedToys(), SharedTagging()) }
        val api = PetStoreApiClient(createClient { petStoreDefaults() }, "")
        val pet = Pet(42, "Milo", Species.BIRD, Instant.parse("2026-01-02T03:04:05Z"), note = null)

        assertEquals(pet, api.pets.create(pet))
        assertEquals(pet, api.pets.read(42))
        assertEquals(BigDecimal("1.25"), api.pets.read(42).price)
        assertEquals(Page(listOf(pet), 1), api.pets.list(limit = 1))
        val wire = Json.parseToJsonElement(client.get("/pets/42").bodyAsText()).jsonObject
        assertEquals(JsonPrimitive("2026-01-02T03:04:05Z"), wire["born_at"])
        assertEquals(Json.parseToJsonElement("null"), wire["note"])

        api.pets.remove(42)
        val missing = assertFailsWith<NotFoundException> { api.pets.read(42) }
        assertEquals(404, missing.status)
        assertEquals("pet not found", missing.error.message)
        assertEquals(Page(emptyList(), 0), api.pets.list())
    }

    @Test
    fun bindsParametersAndCollectionBodies() = testApplication {
        application { petStoreModule(SharedPets(), SharedToys(), SharedTagging()) }
        val api = PetStoreApiClient(createClient { petStoreDefaults() }, "")

        for (name in listOf("a/b", "雪 ?#%", "literal%2Fslash")) {
            val binding = try {
                api.pets.lookup(name, active = false, trace = "")
            } catch (failure: Exception) {
                throw AssertionError("lookup failed for path parameter '$name'", failure)
            }
            assertEquals(Binding(name, false, ""), binding)
        }
        assertEquals(Binding("absent"), api.pets.lookup("absent"))
        for (labels in listOf(listOf("cat", "雪", ""), emptyList())) {
            assertEquals(labels, api.pets.labels(labels))
        }
    }

    @Test
    fun roundTripsUnionVariantsAndAdditionalProperties() = testApplication {
        application { petStoreModule(SharedPets(), SharedToys(), SharedTagging()) }
        val api = PetStoreApiClient(createClient { petStoreDefaults() }, "")

        for (toy in listOf(Ball("red"), Kite("blue", 2.5))) {
            assertEquals(toy, api.toys.echo(toy))
        }
        val tags = Tags("Milo", mapOf("region" to "east"))
        assertEquals(
            tags.copy(additionalProperties = tags.additionalProperties + mapOf("sort" to "7")),
            api.tagging.echo(sort = JsonPrimitive(7), tags = tags),
        )
    }
}
