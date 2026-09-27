package com.example.library

import com.example.library.v1.api.NotFoundException as V1NotFoundException
import com.example.library.v1.client.LibraryApiClient as V1Client
import com.example.library.v1.client.libraryDefaults as v1Defaults
import com.example.library.v1.models.API_VERSION as V1_API_VERSION
import com.example.library.v1.models.Book as V1Book
import com.example.library.v1.models.Genre as V1Genre
import com.example.library.v1.models.NotFound as V1NotFound
import com.example.library.v1.models.PageBook as V1PageBook
import com.example.library.v1.server.BooksService as V1BooksService
import com.example.library.v1.server.libraryModule as v1Module
import com.example.library.v2.api.NotFoundException as V2NotFoundException
import com.example.library.v2.client.LibraryApiClient as V2Client
import com.example.library.v2.client.libraryDefaults as v2Defaults
import com.example.library.v2.models.API_VERSION as V2_API_VERSION
import com.example.library.v2.models.Book as V2Book
import com.example.library.v2.models.Genre as V2Genre
import com.example.library.v2.models.NotFound as V2NotFound
import com.example.library.v2.models.Page as V2Page
import com.example.library.v2.models.Review
import com.example.library.v2.server.BooksService as V2BooksService
import com.example.library.v2.server.libraryModule as v2Module
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class V1Books : V1BooksService {
    val books = linkedMapOf(1L to V1Book(1, "Dune", V1Genre.FICTION, shelf = "A1", author = "Herbert", pages = 412))

    override suspend fun list(limit: Int?): V1PageBook = V1PageBook(books.values.take(limit ?: Int.MAX_VALUE))

    override suspend fun get(id: Long): V1Book = books[id] ?: throw V1NotFoundException(V1NotFound("book $id"))

    override suspend fun remove(id: Long) {
        books.remove(id) ?: throw V1NotFoundException(V1NotFound("book $id"))
    }
}

class V2Books : V2BooksService {
    private val books = listOf(
        V2Book(1, "Dune", V2Genre.FICTION, isbn = "978-0441013593", author = "Herbert", pages = 412),
        V2Book(2, "Odes", V2Genre.POETRY, pages = 5_000_000_000),
    )

    override suspend fun list(limit: Int?, genre: V2Genre?): V2Page<V2Book> {
        val matching = books.filter { genre == null || it.genre == genre }
        val page = matching.take(limit ?: Int.MAX_VALUE)
        return V2Page(page, next = if (page.size < matching.size) "more" else null)
    }

    override suspend fun get(id: Long): V2Book = books.find { it.id == id } ?: throw V2NotFoundException(V2NotFound("book $id"))

    override suspend fun reviews(id: Long): List<Review> = listOf(Review(5, "classic"), Review(4))
}

class VersioningE2ETest {
    @Test
    fun versionConstants() {
        assertEquals("2024-01-01", V1_API_VERSION)
        assertEquals("2024-06-01", V2_API_VERSION)
    }

    @Test
    fun v1WireFormatUsesOldNames() {
        val json = Json.encodeToString(V1Book.serializer(), V1Book(1, "Dune", V1Genre.FICTION, author = "Herbert", pages = 1))
        assertEquals(setOf("id", "name", "genre", "author", "pages"), Json.parseToJsonElement(json).jsonObject.keys)
    }

    @Test
    fun v1ClientTalksToV1Server() = testApplication {
        val service = V1Books()
        application { v1Module(service) }
        val api = V1Client(createClient { v1Defaults() }, "http://localhost")
        assertEquals("Dune", api.books.get(1).name)
        assertEquals(listOf("A1"), api.books.list(null).items.map { it.shelf })
        api.books.remove(1)
        assertFailsWith<V1NotFoundException> { api.books.get(1) }
    }

    @Test
    fun v2ClientTalksToV2Server() = testApplication {
        application { v2Module(V2Books()) }
        val api = V2Client(createClient { v2Defaults() }, "http://localhost")
        assertEquals("Dune", api.books.get(1).title)
        assertEquals(5_000_000_000, api.books.get(2).pages)
        val page = api.books.list(limit = 1, genre = null)
        assertEquals(listOf(1L), page.items.map { it.id })
        assertEquals("more", page.next)
        assertEquals(listOf("Odes"), api.books.list(null, V2Genre.POETRY).items.map { it.title })
        assertEquals(listOf(5, 4), api.books.reviews(1).map { it.stars })
        assertFailsWith<V2NotFoundException> { api.books.get(9) }
    }
}
