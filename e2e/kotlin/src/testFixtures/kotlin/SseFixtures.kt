package com.example.petstore

import com.example.petstore.api.ApiErrorException
import com.example.petstore.api.NotFoundException
import com.example.petstore.models.ApiError
import com.example.petstore.models.FeedFilter
import com.example.petstore.models.NotFound
import com.example.petstore.models.Pet
import com.example.petstore.models.PetEvents
import com.example.petstore.models.SseMessage
import com.example.petstore.models.Species
import com.example.petstore.server.FeedService
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.onCompletion
import java.time.Instant

val feedPet = Pet(id = 1, name = "Rex", species = Species.DOG, bornAt = Instant.parse("2020-01-01T00:00:00Z"))
private val seen = Instant.parse("2026-09-27T10:00:00.123Z")

/** The feed as the service streams it: the events after the terminal one must never reach the client. */
private val feed = listOf(
    PetEvents.Added(feedPet),
    PetEvents.Note("line one\nline two\r\nline three\rline four"),
    PetEvents.Note(""),
    PetEvents.Count(3),
    PetEvents.Seen(seen),
    PetEvents.Done,
    PetEvents.Note("after the end"),
)

/** The received feed: CR, LF and CRLF line breaks all arrive as "\n". */
val receivedFeedEvents = listOf(
    PetEvents.Added(feedPet),
    PetEvents.Note("line one\nline two\nline three\nline four"),
    PetEvents.Note(""),
    PetEvents.Count(3),
    PetEvents.Seen(seen),
    PetEvents.Done,
)

class DemoFeed : FeedService {
    /** Complete (with the cause) when an endless stream stops being collected. */
    val endlessStopped = CompletableDeferred<Throwable?>()
    val pluginStopped = CompletableDeferred<Throwable?>()

    override suspend fun watch(fail: Int?, endless: Boolean?): Flow<PetEvents> {
        when (fail) {
            404 -> throw NotFoundException(NotFound("no feed"))
            400 -> throw ApiErrorException(ApiError("bad_feed", "bad feed"), 400)
        }
        if (endless == true) return endless().onCompletion { endlessStopped.complete(it) }
        return feed.asFlowOfEvents()
    }

    private fun endless(): Flow<PetEvents> = flow {
        var n = 0
        while (true) {
            emit(PetEvents.Count(n++))
            delay(10)
        }
    }

    override suspend fun watchPlugin(filter: FeedFilter): Flow<PetEvents> {
        if (filter.species == Species.BIRD) throw NotFoundException(NotFound("no birds"))
        if (filter.endless == true) return endless().onCompletion { pluginStopped.complete(it) }
        return feed.asFlowOfEvents()
    }

    override suspend fun raw(count: Int): Flow<SseMessage> = flow {
        repeat(count) { emit(SseMessage("message $it", if (it == 1) "custom" else null, "$it")) }
    }
}

private fun List<PetEvents>.asFlowOfEvents(): Flow<PetEvents> = flow { forEach { emit(it) } }

/** Untyped messages whose id and event carry line breaks (and a NUL): they must not forge fields or events. */
class HostileFeed(private val base: FeedService = DemoFeed()) : FeedService by base {
    override suspend fun raw(count: Int): Flow<SseMessage> = flow {
        emit(SseMessage("real", event = "e\r\ndata: forged-event", id = "1\n\ndata: forged"))
        emit(SseMessage("next", id = "bad\u0000id"))
        emit(SseMessage("last", event = "\n"))
    }
}
