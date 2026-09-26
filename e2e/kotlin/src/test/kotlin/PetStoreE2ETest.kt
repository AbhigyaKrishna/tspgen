package com.example.petstore

import com.example.petstore.api.ApiErrorException
import com.example.petstore.api.CreateResult
import com.example.petstore.api.NotFoundException
import com.example.petstore.client.PetStoreApiClient
import com.example.petstore.client.petStoreDefaults
import com.example.petstore.models.ApiError
import com.example.petstore.models.Ball
import com.example.petstore.models.NotFound
import com.example.petstore.models.Pet
import com.example.petstore.models.Rope
import com.example.petstore.models.Species
import com.example.petstore.models.Toy
import com.example.petstore.server.PetsService
import com.example.petstore.server.ToysService
import com.example.petstore.server.petStoreModule
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.time.Instant

class InMemoryPets : PetsService {
    private val pets = linkedMapOf<Long, Pet>()

    override suspend fun list(limit: Int?, tags: List<String>?, species: Species?): List<Pet> {
        if (limit != null && limit < 0) throw ApiErrorException(ApiError("bad_limit", "limit must be >= 0"), 400)
        return pets.values
            .filter { pet -> tags == null || pet.tags.orEmpty().any(tags::contains) }
            .filter { pet -> species == null || pet.species == species }
            .take(limit ?: Int.MAX_VALUE)
    }

    override suspend fun get(petId: Long, trace: String?): Pet =
        pets[petId] ?: throw NotFoundException(NotFound("pet $petId not found"))

    override suspend fun create(pet: Pet): CreateResult =
        if (pets.containsKey(pet.id)) {
            CreateResult.Ok(pet)
        } else {
            pets[pet.id] = pet
            CreateResult.Created(pet, "/pets/${pet.id}")
        }

    override suspend fun remove(petId: Long) {
        pets.remove(petId) ?: throw NotFoundException(NotFound("pet $petId not found"))
    }
}

class InMemoryToys : ToysService {
    private val toys = mutableListOf<Toy>()

    override suspend fun list(): List<Toy> = toys

    override suspend fun add(toy: Toy) {
        toys += toy
    }
}

class PetStoreE2ETest {
    @Test
    fun generatedClientTalksToGeneratedServer() = testApplication {
        application { petStoreModule(InMemoryPets(), InMemoryToys()) }
        val api = PetStoreApiClient(createClient { petStoreDefaults() }, "http://localhost")

        val rex = Pet(
            id = 1,
            name = "Rex",
            species = Species.DOG,
            tags = listOf("good"),
            bornAt = Instant.parse("2020-01-01T00:00:00Z"),
        )
        assertEquals(CreateResult.Created(rex, "/pets/1"), api.pets.create(rex))
        assertEquals(CreateResult.Ok(rex), api.pets.create(rex))
        assertEquals(rex, api.pets.get(1, trace = "abc"))
        assertEquals(listOf(rex), api.pets.list(limit = 10, tags = listOf("good"), species = Species.DOG))
        assertEquals(emptyList(), api.pets.list(species = Species.BIRD))

        val missing = assertFailsWith<NotFoundException> { api.pets.get(99) }
        assertEquals(404, missing.status)
        assertEquals("pet 99 not found", missing.error.message)

        val bad = assertFailsWith<ApiErrorException> { api.pets.list(limit = -1) }
        assertEquals(400, bad.status)
        assertEquals("bad_limit", bad.error.code)

        api.pets.remove(1)
        assertFailsWith<NotFoundException> { api.pets.remove(1) }

        api.toys.add(Ball(name = "red", diameter = 3.5f))
        api.toys.add(Rope(name = "long", length = 2))
        assertEquals(listOf(Ball("red", 3.5f), Rope("long", 2)), api.toys.list())
    }
}
