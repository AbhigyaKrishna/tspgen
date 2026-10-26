package com.example.petstore

import com.example.petstore.api.ApiErrorException
import com.example.petstore.api.ApiException
import com.example.petstore.api.CreateResult
import com.example.petstore.api.NotFoundException
import com.example.petstore.models.Accessory
import com.example.petstore.models.ApiError
import com.example.petstore.models.NotFound
import com.example.petstore.models.Page
import com.example.petstore.models.Pet
import com.example.petstore.models.Species
import com.example.petstore.models.FileReceipt
import com.example.petstore.models.HttpFile
import com.example.petstore.models.PhotoUpload
import com.example.petstore.models.Toy
import com.example.petstore.models.UploadReceipt
import com.example.petstore.server.PhotoUploadPart
import com.example.petstore.server.UploadsService
import com.example.petstore.server.AccessoriesService
import com.example.petstore.server.PetsService
import com.example.petstore.server.ToysService
import com.example.petstore.server.petStoreModule
import io.ktor.client.request.get
import io.ktor.http.content.MultiPartData
import io.ktor.http.content.PartData
import io.ktor.http.content.forEachPart
import io.ktor.http.contentType
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.auth.Authentication
import io.ktor.server.auth.UserIdPrincipal
import io.ktor.server.auth.bearer
import io.ktor.utils.io.ByteReadChannel
import io.ktor.utils.io.toByteArray
import kotlinx.serialization.json.Json
import kotlinx.coroutines.flow.Flow
import java.time.Instant

class InMemoryPets : PetsService {
    private val pets = linkedMapOf<Long, Pet>()

    override suspend fun list(limit: Int?, tags: List<String>?, species: Species?, bornAfter: Instant?): List<Pet> {
        if (limit != null && limit < 0) throw ApiErrorException(ApiError("bad_limit", "limit must be >= 0"), 400)
        return pets.values
            .filter { pet -> tags == null || pet.tags.orEmpty().any(tags::contains) }
            .filter { pet -> species == null || pet.species == species }
            .filter { pet -> bornAfter == null || pet.bornAt?.isAfter(bornAfter) == true }
            .take(limit ?: Int.MAX_VALUE)
    }

    override suspend fun get(petId: Long, trace: String?): Pet {
        // An unmapped ApiException: a problem+json response, though get declares ApiError as its default error.
        if (petId < 0) throw ApiException(422, "petId must not be negative")
        return pets[petId] ?: throw NotFoundException(NotFound("pet $petId not found"))
    }

    override suspend fun create(pet: Pet): CreateResult =
        if (pets.containsKey(pet.id)) {
            CreateResult.Ok(pet)
        } else {
            pets[pet.id] = pet
            CreateResult.Created(pet, "/pets/${pet.id}")
        }

    override suspend fun latest(dates: List<Instant>): Instant = dates.max()

    override suspend fun remove(petId: Long) {
        pets.remove(petId) ?: throw NotFoundException(NotFound("pet $petId not found"))
    }
}

class InMemoryToys : ToysService {
    private val toys = mutableListOf<Toy>()

    override suspend fun list(): List<Toy> = toys

    override suspend fun add(toy: Toy) {
        if (toy.name == "taken") throw ApiException(409, "toy taken already exists")
        toys += toy
    }
}

class InMemoryAccessories : AccessoriesService {
    private val accessories = mutableListOf<Accessory>()

    override suspend fun page(offset: Int?): Page<Accessory> =
        Page(accessories.drop(offset ?: 0), accessories.size)

    override suspend fun add(accessory: Accessory) {
        accessories += accessory
    }
}

private fun describeFile(part: String, filename: String?, contentType: String?, bytes: ByteArray): String =
    "$part:$filename:$contentType:${bytes.decodeToString()}"

class RecordingUploads : UploadsService {
    override suspend fun buffered(body: PhotoUpload): UploadReceipt =
        UploadReceipt(
            caption = body.caption,
            rating = body.rating,
            petName = body.pet.name,
            files = (listOf("photo" to body.photo) + body.extras.orEmpty().map { "extras" to it })
                .map { (part, file) -> describeFile(part, file.filename, file.contentType, file.bytes) },
        )

    override suspend fun streaming(parts: Flow<PhotoUploadPart>): UploadReceipt {
        var caption = ""
        var rating: Int? = null
        var petName = ""
        val files = mutableListOf<String>()
        parts.collect { part ->
            when (part) {
                is PhotoUploadPart.Caption -> caption = part.value
                is PhotoUploadPart.Rating -> rating = part.value
                is PhotoUploadPart.Pet -> petName = part.value.name
                is PhotoUploadPart.Photo -> files += describeFile("photo", part.filename, part.contentType, part.channel.toByteArray())
                is PhotoUploadPart.Extras -> files += describeFile("extras", part.filename, part.contentType, part.channel.toByteArray())
            }
        }
        return UploadReceipt(caption, rating, petName, files)
    }

    override suspend fun raw(data: MultiPartData): UploadReceipt {
        val fields = mutableMapOf<String, String>()
        val files = mutableListOf<String>()
        data.forEachPart { part ->
            when (part) {
                is PartData.FormItem -> fields[part.name!!] = part.value
                is PartData.FileItem ->
                    files += describeFile(part.name!!, part.originalFileName, part.contentType?.toString(), part.provider().toByteArray())
                else -> Unit
            }
            part.release()
        }
        return UploadReceipt(
            caption = fields.getValue("caption"),
            rating = fields["rating"]?.toInt(),
            petName = Json.decodeFromString<Pet>(fields.getValue("pet")).name,
            files = files,
        )
    }

    override suspend fun file(file: HttpFile): FileReceipt = FileReceipt(file.filename, file.contentType, file.bytes.decodeToString())

    override suspend fun fileStream(contentType: String?, channel: ByteReadChannel): FileReceipt =
        FileReceipt(null, contentType, channel.toByteArray().decodeToString())
}

/** The PetStore module with in-memory services; the "api" bearer provider accepts the token "secret". */
fun Application.installPetStore() {
    install(Authentication) {
        bearer("api") {
            authenticate { credential -> if (credential.token == "secret") UserIdPrincipal("tester") else null }
        }
    }
    petStoreModule(
        extrasService = RecordingExtras(),
        petsService = InMemoryPets(),
        toysService = InMemoryToys(),
        accessoriesService = InMemoryAccessories(),
        uploadsService = RecordingUploads(),
        feedService = DemoFeed(),
    )
}
