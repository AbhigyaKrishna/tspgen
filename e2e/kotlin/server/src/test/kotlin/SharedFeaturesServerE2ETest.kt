package com.example.shared

import com.example.shared.server.petStoreModule
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

private const val validPet = """{"id":1,"name":"Milo","species":"parrot","born_at":"2026-01-02T03:04:05Z","note":null}"""

class SharedFeaturesServerE2ETest {
    @Test
    fun writesEncodedNamesNullableFieldsEnumsAndOptionalDefaults() = testApplication {
        application { petStoreModule(SharedPets(), SharedToys(), SharedTagging()) }
        val response = client.post("/pets") {
            contentType(ContentType.Application.Json)
            setBody(validPet)
        }
        assertEquals(HttpStatusCode.Created, response.status)
        val fields = Json.parseToJsonElement(response.bodyAsText()).jsonObject
        assertEquals(JsonPrimitive("parrot"), fields["species"])
        assertEquals(JsonPrimitive("2026-01-02T03:04:05Z"), fields["born_at"])
        assertEquals(Json.parseToJsonElement("null"), fields["note"])
        assertFalse("price" in fields)
    }

    @Test
    fun rejectsMalformedAndConstrainedRequestsBeforeCallingServices() = testApplication {
        application { petStoreModule(SharedPets(), SharedToys(), SharedTagging()) }
        val invalidBodies = listOf(
            "{",
            validPet.replace("Milo", "x"),
            validPet.replace("parrot", "dragon"),
            validPet.replace("2026-01-02T03:04:05Z", "yesterday"),
            validPet.replace("\"name\":\"Milo\",", ""),
        )
        for (body in invalidBodies) {
            val response = client.post("/pets") {
                contentType(ContentType.Application.Json)
                setBody(body)
            }
            assertEquals(HttpStatusCode.BadRequest, response.status, body)
        }
        for (path in listOf("/pets/0", "/pets/not-an-integer", "/pets?limit=0", "/pets?limit=abc")) {
            assertEquals(HttpStatusCode.BadRequest, client.get(path).status, path)
        }
        assertEquals("""{"items":[],"total":0}""", client.get("/pets").bodyAsText())
    }

    @Test
    fun bindsEncodedPathQueryAndHeaderParameters() = testApplication {
        application { petStoreModule(SharedPets(), SharedToys(), SharedTagging()) }
        val response = client.get("/pets/names/a%2Fb?active=false") {
            header("x-trace", "")
        }
        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals(
            """{"name":"a/b","active":false,"trace":""}""",
            response.bodyAsText(),
        )
    }
}
