package com.example.clash

import com.example.clash.client.ClashApiClient
import com.example.clash.client.clashDefaults
import com.example.clash.models.Readings
import com.example.clash.models.SseEvent
import com.example.clash.models.SseFrame
import com.example.clash.server.MeterService
import com.example.clash.server.clashModule
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import com.example.clash.models.Flow as Reading

private val reading = Reading(rate = 60)

class Meter : MeterService {
    override suspend fun last(): Reading = reading

    override suspend fun readings(): kotlinx.coroutines.flow.Flow<Readings> = flow {
        emit(Readings.FlowEvent(reading))
        emit(Readings.Event(SseEvent("e1")))
        emit(Readings.Frame(SseFrame(2)))
    }

    override suspend fun pluginReadings(): kotlinx.coroutines.flow.Flow<Readings> = readings()
}

/** Models named Flow, SseEvent and SseFrame compile next to the generated stream code; REST and events share JSON. */
class ClashE2ETest {
    @Test
    fun namesLikeGeneratedInternalsAndSharedJson() = testApplication {
        application { clashModule(Meter()) }
        val api = ClashApiClient(createClient { clashDefaults() }, "http://localhost")
        val expected = listOf(Readings.FlowEvent(reading), Readings.Event(SseEvent("e1")), Readings.Frame(SseFrame(2)))
        assertEquals(expected, api.meter.readings().toList())
        assertEquals(expected, api.meter.pluginReadings().toList())
        assertEquals(reading, api.meter.last())

        // serverJson (encodeDefaults = false) for REST and events alike: unset optionals (unit's default, null note) are omitted.
        val rest = client.get("/meter/last").bodyAsText()
        assertEquals("""{"rate":60}""", rest)
        for (path in listOf("/meter/stream", "/meter/plugin")) {
            val text = client.get(path).bodyAsText().replace("\r\n", "\n")
            assertTrue(text.startsWith("event: flow\ndata: $rest\n"), text)
        }
    }
}
