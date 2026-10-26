package com.example.shared

import com.example.shared.api.NotFoundException
import com.example.shared.models.Binding
import com.example.shared.models.NotFound
import com.example.shared.models.Page
import com.example.shared.models.Pet
import com.example.shared.models.Sort
import com.example.shared.models.Tags
import com.example.shared.models.Toy
import com.example.shared.server.PetsService
import com.example.shared.server.TaggingService
import com.example.shared.server.ToysService

class SharedPets : PetsService {
    private val pets = sortedMapOf<Long, Pet>()

    override suspend fun list(limit: Int?) = Page(pets.values.take(limit ?: pets.size), pets.size)

    override suspend fun read(id: Long) = pets[id] ?: throw NotFoundException(NotFound("pet not found"))

    override suspend fun create(pet: Pet): Pet {
        pets[pet.id] = pet
        return pet
    }

    override suspend fun remove(id: Long) {
        pets.remove(id) ?: throw NotFoundException(NotFound("pet not found"))
    }

    override suspend fun lookup(name: String, active: Boolean?, trace: String?) = Binding(name, active, trace)

    override suspend fun labels(labels: List<String>) = labels

    override suspend fun fail(): Pet = error("private database failure")
}

class SharedToys : ToysService {
    override suspend fun echo(toy: Toy) = toy
}

class SharedTagging : TaggingService {
    override suspend fun echo(sort: Sort?, tags: Tags) = tags.copy(
        additionalProperties = tags.additionalProperties + mapOf("sort" to sort.toString()),
    )
}
