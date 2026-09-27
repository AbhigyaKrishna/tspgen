package com.example.petstore

import com.example.petstore.api.ApiErrorException
import com.example.petstore.api.ApiException
import com.example.petstore.api.CreateResult
import com.example.petstore.api.NotFoundException
import com.example.petstore.client.PetStoreApiClient
import com.example.petstore.client.petStoreDefaults
import com.example.petstore.models.Accessory
import com.example.petstore.models.ApiError
import com.example.petstore.models.Ball
import com.example.petstore.models.NotFound
import com.example.petstore.models.Page
import com.example.petstore.models.Pet
import com.example.petstore.models.Rope
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
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.plugins.expectSuccess
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.forms.MultiPartFormDataContent
import io.ktor.client.request.forms.formData
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.MultiPartData
import io.ktor.http.content.PartData
import io.ktor.http.content.forEachPart
import io.ktor.http.contentType
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.auth.Authentication
import io.ktor.server.auth.UserIdPrincipal
import io.ktor.server.auth.bearer
import io.ktor.server.testing.testApplication
import io.ktor.utils.io.ByteReadChannel
import io.ktor.utils.io.toByteArray
import io.ktor.client.statement.HttpResponse
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.Serializable
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
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

class PetStoreE2ETest {
    @Test
    fun responsesOmitUnsetOptionalProperties() = testApplication {
        application { installPetStore() }
        val created = client.post("/pets") {
            contentType(ContentType.Application.Json)
            setBody("""{"id":7,"name":"Tom","species":"cat"}""")
        }
        assertEquals(HttpStatusCode.Created, created.status)
        // No "tags":null / "born_at":null, and weight (default 1.0) is omitted.
        assertEquals("""{"id":7,"name":"Tom","species":"cat"}""", client.get("/pets/7").bodyAsText())

        // Required properties with a default are written even when equal to it (the TypeScript schemas require them).
        client.post("/accessories") {
            contentType(ContentType.Application.Json)
            setBody("""{"type":"collar","size":3}""")
        }
        assertEquals(
            """{"items":[{"type":"collar","size":3,"material":"leather","rings":1}],"total":1}""",
            client.get("/accessories").bodyAsText(),
        )
    }

    @Test
    fun errorsWithoutADeclaredBodyAnswerProblemJson() = testApplication {
        application { installPetStore() }
        suspend fun problem(response: HttpResponse, status: HttpStatusCode): JsonObject {
            assertEquals(status, response.status)
            assertEquals(ContentType.Application.ProblemJson, response.contentType()?.withoutParameters())
            return Json.parseToJsonElement(response.bodyAsText()).jsonObject
        }
        val taken = client.post("/toys") {
            contentType(ContentType.Application.Json)
            setBody("""{"kind":"ball","name":"taken","diameter":1.0}""")
        }
        assertEquals(
            """{"type":"about:blank","title":"Conflict","status":409,"detail":"toy taken already exists"}""",
            problem(taken, HttpStatusCode.Conflict).toString(),
        )
        val malformed = client.post("/toys") {
            contentType(ContentType.Application.Json)
            setBody("{")
        }
        assertEquals("Bad Request", problem(malformed, HttpStatusCode.BadRequest)["title"]?.jsonPrimitive?.content)
        val missing = problem(client.get("/feed/raw"), HttpStatusCode.BadRequest)
        assertTrue(missing["detail"]?.jsonPrimitive?.content.orEmpty().contains("count"), missing.toString())
        val unparsable = problem(client.get("/pets/abc"), HttpStatusCode.BadRequest)
        assertTrue(unparsable["detail"]?.jsonPrimitive?.content.orEmpty().contains("petId"), unparsable.toString())

        // Bodies that do not decode: a generic detail (missing fields, JSON path), never the models' package or the body.
        val details = listOf(
            "{" to "Malformed request body at path $",
            """{"id":7}""" to "Malformed request body: missing 'name', 'species'",
            """{"id":7,"name":"Tom","species":"dragon"}""" to "Malformed request body at path $.species",
            """{"id":"x","name":"Tom","species":"cat"}""" to "Malformed request body at path $.id",
        ).map { (body, expected) ->
            val response = client.post("/pets") {
                contentType(ContentType.Application.Json)
                setBody(body)
            }
            val detail = problem(response, HttpStatusCode.BadRequest)["detail"]?.jsonPrimitive?.content.orEmpty()
            assertEquals(expected, detail, body)
            detail
        }
        for (detail in details + listOf(missing.toString(), unparsable.toString())) {
            assertFalse("com.example.petstore" in detail || "JSON input" in detail || "Tom" in detail, detail)
        }
        val unsupported = client.post("/pets") {
            contentType(ContentType.Text.Plain)
            setBody("Tom")
        }
        // Ktor's own message would name the model class.
        assertEquals(
            "Content type text/plain; charset=UTF-8 is not supported",
            problem(unsupported, HttpStatusCode.UnsupportedMediaType)["detail"]?.jsonPrimitive?.content,
        )
    }

    @Test
    fun generatedClientTalksToGeneratedServer() = testApplication {
        application {
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
        val api = PetStoreApiClient(
            createClient {
                petStoreDefaults()
                defaultRequest { bearerAuth("secret") }
            },
            "http://localhost",
        )
        val anonymous = PetStoreApiClient(createClient { petStoreDefaults() }, "http://localhost")

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
        assertEquals(listOf(rex), api.pets.list(bornAfter = Instant.parse("2019-06-01T12:30:00Z")))
        assertEquals(emptyList(), api.pets.list(bornAfter = Instant.parse("2021-01-01T00:00:00Z")))

        assertEquals(
            Instant.parse("2021-05-01T00:00:00Z"),
            api.pets.latest(listOf(Instant.parse("2020-01-01T00:00:00Z"), Instant.parse("2021-05-01T00:00:00Z"))),
        )

        val missing = assertFailsWith<NotFoundException> { api.pets.get(99) }
        assertEquals(404, missing.status)
        assertEquals("pet 99 not found", missing.error.message)

        // A problem+json response is never decoded as the declared error model (ApiError).
        val problem = assertFailsWith<ApiException> { api.pets.get(-1) }
        assertFalse(problem is ApiErrorException)
        assertEquals(422, problem.status)
        assertEquals("petId must not be negative", problem.message)

        val bad = assertFailsWith<ApiErrorException> { api.pets.list(limit = -1) }
        assertEquals(400, bad.status)
        assertEquals("bad_limit", bad.error.code)

        val unauthorized = assertFailsWith<ApiException> { anonymous.pets.remove(1) }
        assertEquals(401, unauthorized.status)

        api.pets.remove(1)
        assertFailsWith<NotFoundException> { api.pets.remove(1) }

        api.toys.add(Ball(name = "red", diameter = 3.5f))
        api.toys.add(Rope(name = "long", length = 2))
        assertEquals(listOf(Ball("red", 3.5f), Rope("long", 2)), api.toys.list())
        assertTrue(Serializable::class.java.isAssignableFrom(Ball::class.java))

        val taken = assertFailsWith<ApiException> { api.toys.add(Ball(name = "taken", diameter = 1f)) }
        assertEquals(409, taken.status)
        assertEquals("toy taken already exists", taken.message)

        // Generated calls map errors themselves, also on clients built with expectSuccess = true.
        val strict = PetStoreApiClient(createClient { petStoreDefaults(); expectSuccess = true }, "http://localhost")
        assertEquals(404, assertFailsWith<NotFoundException> { strict.pets.get(99) }.status)

        api.accessories.add(Accessory.Collar(size = 3))
        api.accessories.add(Accessory.Tag(text = "Rex"))
        assertEquals(Page(listOf(Accessory.Collar(3), Accessory.Tag("Rex")), 2), api.accessories.page())
        assertEquals(Page(listOf<Accessory>(Accessory.Tag("Rex")), 2), api.accessories.page(offset = 1))
    }

    @Test
    fun uploadsReachEveryServerMode() = testApplication {
        application {
            install(Authentication) { bearer("api") { authenticate { null } } }
            petStoreModule(
                extrasService = RecordingExtras(),
                petsService = InMemoryPets(),
                toysService = InMemoryToys(),
                accessoriesService = InMemoryAccessories(),
                uploadsService = RecordingUploads(),
                feedService = DemoFeed(),
            )
        }
        val api = PetStoreApiClient(createClient { petStoreDefaults() }, "http://localhost")
        val rex = Pet(id = 1, name = "Rex", species = Species.DOG)
        val upload = PhotoUpload(
            caption = "Rex at the park",
            rating = 5,
            pet = rex,
            photo = HttpFile("rex.png", "image/png", "png-bytes".encodeToByteArray()),
            extras = listOf(HttpFile(null, null, "extra".encodeToByteArray())),
        )
        val expected = UploadReceipt(
            caption = "Rex at the park",
            rating = 5,
            petName = "Rex",
            files = listOf("photo:rex.png:image/png:png-bytes", "extras:extras:application/octet-stream:extra"),
        )
        assertEquals(expected, api.uploads.buffered(upload))
        assertEquals(expected, api.uploads.streaming(upload))
        assertEquals(expected, api.uploads.raw(upload))
        assertEquals(
            UploadReceipt("Rex at the park", null, "Rex", listOf("photo:rex.png:image/png:png-bytes")),
            api.uploads.buffered(upload.copy(rating = null, extras = null)),
        )

        assertEquals(
            FileReceipt("notes.txt", "text/plain", "hello"),
            api.uploads.file(HttpFile("notes.txt", "text/plain", "hello".encodeToByteArray())),
        )
        assertEquals(
            FileReceipt(null, "application/octet-stream", "raw bytes"),
            api.uploads.fileStream(HttpFile(null, null, "raw bytes".encodeToByteArray())),
        )

        val missingPhoto = client.post("/uploads/buffered") {
            setBody(MultiPartFormDataContent(formData { append("caption", "x") }))
        }
        assertEquals(HttpStatusCode.BadRequest, missingPhoto.status)
    }
}
