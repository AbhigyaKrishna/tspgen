package com.example.petstore

import com.example.petstore.api.ApiException
import com.example.petstore.client.PetStoreApiClient
import com.example.petstore.client.petStoreDefaults
import com.example.petstore.models.BlobForm
import com.example.petstore.models.EnvelopeForm
import com.example.petstore.models.FileReceipt
import com.example.petstore.models.HttpFile
import com.example.petstore.models.NoteForm
import com.example.petstore.models.NoteReceipt
import com.example.petstore.models.Pet
import com.example.petstore.models.PhotoUpload
import com.example.petstore.models.Species
import com.example.petstore.models.UploadReceipt
import com.example.petstore.server.ExtrasService
import com.example.petstore.server.NoteFormPart
import com.example.petstore.server.PhotoUploadPart
import com.example.petstore.server.petStoreModule
import io.ktor.client.request.forms.MultiPartFormDataContent
import io.ktor.client.request.forms.formData
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.MultiPartData
import io.ktor.http.content.PartData
import io.ktor.http.content.forEachPart
import io.ktor.http.contentType
import io.ktor.server.application.install
import io.ktor.server.auth.Authentication
import io.ktor.server.auth.bearer
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import io.ktor.utils.io.toByteArray
import kotlinx.coroutines.flow.Flow
import java.io.IOException
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

private fun ByteArray.hex(): String = joinToString("") { "%02x".format(it) }

class RecordingExtras : ExtrasService {
    override suspend fun notes(body: NoteForm): NoteReceipt =
        NoteReceipt(body.title, body.tags.orEmpty(), body.times.orEmpty(), body.pet?.name)

    override suspend fun notesStream(parts: Flow<NoteFormPart>): NoteReceipt {
        var title = ""
        val tags = mutableListOf<String>()
        var times = emptyList<Instant>()
        var petName: String? = null
        parts.collect { part ->
            when (part) {
                is NoteFormPart.Title -> title = part.value
                is NoteFormPart.Tags -> tags += part.value
                is NoteFormPart.Times -> times = part.value
                is NoteFormPart.Pet -> petName = part.value?.name
            }
        }
        return NoteReceipt(title, tags, times, petName)
    }

    override suspend fun notesRaw(data: MultiPartData): NoteReceipt {
        var title = ""
        val tags = mutableListOf<String>()
        data.forEachPart { part ->
            when (part.name) {
                "title" -> title = (part as PartData.FormItem).value
                "tags" -> tags += (part as PartData.FormItem).value
            }
            part.release()
        }
        return NoteReceipt(title, tags, emptyList(), null)
    }

    /** Collects the flow twice: the second collection must fail. */
    override suspend fun smallStream(parts: Flow<PhotoUploadPart>): UploadReceipt {
        val files = mutableListOf<String>()
        parts.collect { if (it is PhotoUploadPart.Photo) files += it.channel.toByteArray().hex() }
        if (files.size == 1 && files[0] == "collect-twice".encodeToByteArray().hex()) parts.collect { }
        return UploadReceipt("", null, "", files)
    }

    override suspend fun small(body: PhotoUpload): UploadReceipt =
        UploadReceipt(body.caption, body.rating, body.pet.name, listOf(body.photo.bytes.hex()))

    override suspend fun smallRaw(data: MultiPartData): UploadReceipt {
        val files = mutableListOf<String>()
        data.forEachPart { part ->
            if (part is PartData.FileItem) files += part.provider().toByteArray().hex()
            part.release()
        }
        return UploadReceipt("", null, "", files)
    }

    override suspend fun smallFile(file: HttpFile): FileReceipt = FileReceipt(file.filename, file.contentType, file.bytes.hex())

    override suspend fun envelope(body: EnvelopeForm): NoteReceipt = NoteReceipt("", emptyList(), emptyList(), body.pet.name)

    /** The title is the pet part's content type, as sent. */
    override suspend fun envelopeRaw(data: MultiPartData): NoteReceipt {
        var contentType = ""
        data.forEachPart { part ->
            if (part.name == "pet") contentType = part.contentType.toString()
            part.release()
        }
        return NoteReceipt(contentType, emptyList(), emptyList(), null)
    }

    override suspend fun blob(body: BlobForm): FileReceipt =
        FileReceipt(body.blob.filename, body.blob.contentType, body.blob.bytes.hex())
}

/** Raw and streaming services failing on their own with an IOException that mentions a "limit". */
class LimitThrowingExtras(private val recording: RecordingExtras = RecordingExtras()) : ExtrasService by recording {
    override suspend fun smallRaw(data: MultiPartData): UploadReceipt {
        data.readPart()?.release()
        throw IOException("upstream connection limit reached")
    }

    override suspend fun smallStream(parts: Flow<PhotoUploadPart>): UploadReceipt {
        parts.collect { throw IOException("upstream connection limit reached") }
        return UploadReceipt("", null, "", emptyList())
    }
}

private val petJson = """{"id":1,"name":"Rex","species":"dog"}"""

private fun fileHeaders(filename: String?): Headers = Headers.build {
    if (filename != null) append(HttpHeaders.ContentDisposition, "filename=\"$filename\"")
}

class UploadEdgesE2ETest {
    private fun edges(
        extras: ExtrasService = RecordingExtras(),
        block: suspend ApplicationTestBuilder.(PetStoreApiClient) -> Unit,
    ) = testApplication {
        application {
            install(Authentication) { bearer("api") { authenticate { null } } }
            petStoreModule(
                extrasService = extras,
                petsService = InMemoryPets(),
                toysService = InMemoryToys(),
                accessoriesService = InMemoryAccessories(),
                uploadsService = RecordingUploads(),
                feedService = DemoFeed(),
            )
        }
        block(PetStoreApiClient(createClient { petStoreDefaults() }, "http://localhost"))
    }

    @Test
    fun textOnlyMultipartWithJavaTimeJsonParts() = edges { api ->
        val times = listOf(Instant.parse("2026-01-02T03:04:05Z"), Instant.parse("2026-02-03T04:05:06Z"))
        val rex = Pet(id = 1, name = "Rex", species = Species.DOG)
        val form = NoteForm(title = "hello", tags = listOf("a", "b"), times = times, pet = rex)
        assertEquals(NoteReceipt("hello", listOf("a", "b"), times, "Rex"), api.extras.notes(form))
        assertEquals(NoteReceipt("hello", listOf("a", "b"), times, "Rex"), api.extras.notesStream(form))
        assertEquals(NoteReceipt("hello", listOf("a", "b"), emptyList(), null), api.extras.notesRaw(form))
        assertEquals(NoteReceipt("bare", emptyList(), emptyList(), null), api.extras.notes(NoteForm(title = "bare")))
    }

    @Test
    fun filenamesRoundTrip() = edges { api ->
        for (name in listOf("a\\b.png", "x\\", "a\"b.png", "résumé-日本.png", "\"quoted\"")) {
            val upload = PhotoUpload(
                caption = "c",
                pet = Pet(id = 1, name = "Rex", species = Species.DOG),
                photo = HttpFile(name, "image/png", "p".encodeToByteArray()),
            )
            assertEquals(listOf("photo:$name:image/png:p"), api.uploads.buffered(upload).files, name)
            assertEquals(listOf("photo:$name:image/png:p"), api.uploads.streaming(upload).files, name)
        }
    }

    @Test
    fun lineBreaksInFilenamesCannotInjectHeaders() = edges { api ->
        val upload = PhotoUpload(
            caption = "c",
            pet = Pet(id = 1, name = "Rex", species = Species.DOG),
            photo = HttpFile("a\r\nContent-Type: text/evil\r\n.png", "image/png", "p".encodeToByteArray()),
        )
        val receipt = api.uploads.buffered(upload)
        assertEquals("c", receipt.caption)
        // Ktor escapes CR/LF inside the quoted filename; the part keeps its own content type.
        val file = receipt.files.single()
        assertEquals(true, file.startsWith("photo:") && file.endsWith(":image/png:p"), file)
        assertEquals(false, file.contains('\r') || file.contains('\n'), file)
    }

    @Test
    fun envelopePartsCarryTheirBodyAndContentType() = edges { api ->
        val form = EnvelopeForm(Pet(id = 1, name = "Rex", species = Species.DOG))
        assertEquals("Rex", api.extras.envelope(form).petName)
        assertEquals("application/vnd.pet+json", api.extras.envelopeRaw(form).title)
    }

    @Test
    fun bytesPartsAreBinaryFiles() = edges { api ->
        val bytes = byteArrayOf(0xFF.toByte(), 0xFE.toByte(), 0x00, 0x80.toByte(), 0x41)
        assertEquals(
            FileReceipt("blob.bin", "application/octet-stream", bytes.hex()),
            api.extras.blob(BlobForm(HttpFile("blob.bin", null, bytes))),
        )
    }

    @Test
    fun undeclaredPartsAreIgnored() = edges { _ ->
        val response = client.post("/extras/notes") {
            setBody(MultiPartFormDataContent(formData {
                append("junk", "x".repeat(1000))
                append("title", "t")
                append("junkFile", ByteArray(1000), fileHeaders("junk.bin"))
            }))
        }
        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
    }

    @Test
    fun filePartsWithoutFilenameAreRejected() = edges { _ ->
        val binary = byteArrayOf(0xFF.toByte(), 0xFE.toByte(), 0x00)
        for (path in listOf("/uploads/buffered", "/uploads/streaming")) {
            val response = client.post(path) {
                setBody(MultiPartFormDataContent(formData {
                    append("caption", "c")
                    append("pet", petJson)
                    append("photo", binary, fileHeaders(null))
                }))
            }
            assertEquals(HttpStatusCode.BadRequest, response.status, path)
        }
    }

    @Test
    fun oversizedUploadsAnswer413() = edges { api ->
        fun form(photo: ByteArray) = MultiPartFormDataContent(formData {
            append("caption", "c")
            append("pet", petJson)
            append("photo", photo, fileHeaders("a.bin"))
        })
        for (path in listOf("/extras/small", "/extras/small-stream", "/extras/small-raw")) {
            assertEquals(HttpStatusCode.OK, client.post(path) { setBody(form(ByteArray(8))) }.status, path)
            assertEquals(HttpStatusCode.PayloadTooLarge, client.post(path) { setBody(form(ByteArray(100))) }.status, path)
            // A large undeclared/text part is limited too.
            val bigText = client.post(path) {
                setBody(MultiPartFormDataContent(formData { append("caption", "x".repeat(100)) }))
            }
            assertEquals(HttpStatusCode.PayloadTooLarge, bigText.status, "$path text")
        }
        assertEquals(HttpStatusCode.OK, client.put("/extras/small-file") { setBody(ByteArray(64)) }.status)
        assertEquals(HttpStatusCode.PayloadTooLarge, client.put("/extras/small-file") { setBody(ByteArray(65)) }.status)
        val error = assertFailsWith<ApiException> { api.extras.smallFile(HttpFile(null, null, ByteArray(100))) }
        assertEquals(413, error.status)
        val tooBig = client.post("/extras/small") { setBody(form(ByteArray(100))) }
        assertEquals(ContentType.Application.ProblemJson, tooBig.contentType()?.withoutParameters())
        assertTrue("\"status\":413" in tooBig.bodyAsText(), tooBig.bodyAsText())
    }

    @Test
    fun bufferedModelChecksAnswer400() = edges { _ ->
        val response = client.post("/extras/notes") {
            setBody(MultiPartFormDataContent(formData { append("title", " ") }))
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals(ContentType.Application.ProblemJson, response.contentType()?.withoutParameters())
        assertEquals(
            """{"type":"about:blank","title":"Bad Request","status":400,"detail":"title must not be blank"}""",
            response.bodyAsText(),
        )
    }

    @Test
    fun singlePartsSentTwiceAreRejected() = edges { _ ->
        fun form(block: io.ktor.client.request.forms.FormBuilder.() -> Unit) = MultiPartFormDataContent(formData {
            append("caption", "c")
            append("pet", petJson)
            block()
        })
        val twoPhotos = client.post("/uploads/buffered") {
            setBody(form {
                append("photo", byteArrayOf(1), fileHeaders("a.bin"))
                append("photo", byteArrayOf(2), fileHeaders("b.bin"))
            })
        }
        assertEquals(HttpStatusCode.BadRequest, twoPhotos.status)
        assertEquals(true, twoPhotos.bodyAsText().contains("Part 'photo' must be sent at most once"), twoPhotos.bodyAsText())
        val twoCaptions = client.post("/uploads/buffered") {
            setBody(form {
                append("caption", "again")
                append("photo", byteArrayOf(1), fileHeaders("a.bin"))
            })
        }
        assertEquals(HttpStatusCode.BadRequest, twoCaptions.status)
        val twoTitles = client.post("/extras/notes") {
            setBody(MultiPartFormDataContent(formData { append("title", "a"); append("title", "b") }))
        }
        assertEquals(HttpStatusCode.BadRequest, twoTitles.status)
        // Multi parts may repeat.
        val manyExtras = client.post("/uploads/buffered") {
            setBody(form {
                append("photo", byteArrayOf(1), fileHeaders("a.bin"))
                append("extras", byteArrayOf(2), fileHeaders("b.bin"))
                append("extras", byteArrayOf(3), fileHeaders("c.bin"))
            })
        }
        assertEquals(HttpStatusCode.OK, manyExtras.status, manyExtras.bodyAsText())
    }

    @Test
    fun bufferedTotalIsLimited() = edges { _ ->
        // Each part is under /extras/small's 64 bytes; together they are over.
        fun form(extras: Int) = MultiPartFormDataContent(formData {
            append("caption", "c")
            append("pet", petJson)
            append("photo", ByteArray(8), fileHeaders("a.bin"))
            repeat(extras) { append("extras", ByteArray(8), fileHeaders("e.bin")) }
        })
        assertEquals(HttpStatusCode.OK, client.post("/extras/small") { setBody(form(1)) }.status)
        assertEquals(HttpStatusCode.PayloadTooLarge, client.post("/extras/small") { setBody(form(4)) }.status)
        // Streaming and raw hand parts to the service as they arrive: no total.
        assertEquals(HttpStatusCode.OK, client.post("/extras/small-stream") { setBody(form(4)) }.status)
        assertEquals(HttpStatusCode.OK, client.post("/extras/small-raw") { setBody(form(4)) }.status)
    }

    @Test
    fun serviceIOExceptionsAreNot413() = edges(LimitThrowingExtras()) { _ ->
        for (path in listOf("/extras/small-raw", "/extras/small-stream")) {
            // The test host either answers 500 or rethrows the handler's exception.
            val result = runCatching {
                client.post(path) {
                    setBody(MultiPartFormDataContent(formData { append("caption", "c") }))
                }.status
            }
            val failure = result.exceptionOrNull()
            if (failure != null) {
                assertEquals("upstream connection limit reached", failure.message, path)
            } else {
                assertEquals(HttpStatusCode.InternalServerError, result.getOrNull(), path)
            }
        }
    }

    @Test
    fun fileBodyFilenamesRoundTrip() = edges { api ->
        for (name in listOf("plain.png", "a\"b.png", "a\\b.png", "résumé.png", "a;b=c.png")) {
            val file = HttpFile(name, "image/png", "p".encodeToByteArray())
            assertEquals(name, api.uploads.file(file).filename, name)
            assertEquals(name, api.extras.smallFile(file).filename, name)
        }
    }

    @Test
    fun streamingPartsCanBeCollectedOnce() = edges { _ ->
        // The test host either answers 500 or rethrows the handler's exception.
        val result = runCatching {
            client.post("/extras/small-stream") {
                setBody(MultiPartFormDataContent(formData {
                    append("photo", "collect-twice".encodeToByteArray(), fileHeaders("a"))
                }))
            }.status
        }
        val failure = result.exceptionOrNull()
        if (failure != null) {
            assertEquals("The parts of a multipart request can be collected only once", failure.message)
        } else {
            assertEquals(HttpStatusCode.InternalServerError, result.getOrNull())
        }
    }
}
