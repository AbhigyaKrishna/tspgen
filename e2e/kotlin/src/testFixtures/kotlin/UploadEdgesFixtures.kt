package com.example.petstore

import com.example.petstore.models.BlobForm
import com.example.petstore.models.EnvelopeForm
import com.example.petstore.models.FileReceipt
import com.example.petstore.models.HttpFile
import com.example.petstore.models.NoteForm
import com.example.petstore.models.NoteReceipt
import com.example.petstore.models.Pet
import com.example.petstore.models.PhotoUpload
import com.example.petstore.models.UploadReceipt
import com.example.petstore.server.ExtrasService
import com.example.petstore.server.NoteFormPart
import com.example.petstore.server.PhotoUploadPart
import io.ktor.http.content.MultiPartData
import io.ktor.http.content.PartData
import io.ktor.http.content.forEachPart
import io.ktor.http.contentType
import io.ktor.utils.io.toByteArray
import kotlinx.coroutines.flow.Flow
import java.io.IOException
import java.time.Instant

fun ByteArray.hex(): String = joinToString("") { "%02x".format(it) }

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
