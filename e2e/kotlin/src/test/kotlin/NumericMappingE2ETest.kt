package com.example.numericmapping

import com.example.numericmapping.models.ExactText
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class NumericMappingE2ETest {
    @Test
    fun decimalTextPreservesWireKindsAndValidatesLogicalBounds() {
        val wire = """{"value":1.2300e+40,"text":"0.1234567890123456789","date":"2025-01-01T00:00:00Z","elapsed":"PT2S"}"""
        val value = Json.decodeFromString<ExactText>(wire)
        assertEquals("1.2300e+40", value.value)
        assertEquals("0.1234567890123456789", value.text)
        assertEquals(wire, Json.encodeToString(value))
        assertFailsWith<IllegalArgumentException> { value.copy(value = "0.1234567890123456789012344") }
        assertFailsWith<IllegalArgumentException> { value.copy(date = kotlin.time.Instant.parse("2024-01-01T00:00:00Z")) }
        assertFailsWith<IllegalArgumentException> { value.copy(elapsed = kotlin.time.Duration.ZERO) }
        assertFailsWith<SerializationException> { Json.encodeToString(value.copy(value = "01")) }
        assertFailsWith<SerializationException> { Json.encodeToString(value.copy(text = "invalid")) }
        assertFailsWith<SerializationException> { Json.decodeFromString<ExactText>(wire.replace("1.2300e+40", "\"1.2300e+40\"")) }
        assertFailsWith<SerializationException> { Json.decodeFromString<ExactText>(wire.replace("\"0.1234567890123456789\"", "0.1234567890123456789")) }
    }
}
