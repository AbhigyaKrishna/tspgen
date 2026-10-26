package com.example.lifecycle

import com.example.lifecycle.client.LifecycleModelsApiClient
import com.example.lifecycle.client.lifecycleModelsDefaults
import com.example.lifecycle.models.Patch
import com.example.lifecycle.models.User
import com.example.lifecycle.models.UserCreate
import com.example.lifecycle.server.UsersService
import com.example.lifecycle.server.lifecycleModelsModule
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

class LifecycleModelsE2ETest {
    @Test
    fun generatedRequestAndResponseModelsRespectLifecycleVisibility() = testApplication {
        var stored = User("id", "Initial")
        var suppliedPassword: String? = null
        application {
            lifecycleModelsModule(object : UsersService {
                override suspend fun read() = stored

                override suspend fun create(body: UserCreate): User {
                    suppliedPassword = body.password
                    stored = User("id", body.name)
                    return stored
                }

                override suspend fun update(body: Patch): User {
                    stored = stored.copy(name = body.name ?: stored.name)
                    return stored
                }
            })
        }
        val api = LifecycleModelsApiClient(createClient { lifecycleModelsDefaults() }, "")
        val created = api.users.create(UserCreate("secret", "Created"))
        assertEquals("Created", created.name)
        assertEquals("secret", suppliedPassword)
        assertFalse(Json.encodeToString(created).contains("password"))
        assertEquals(created, api.users.update(Patch()))
        assertEquals("Updated", api.users.update(Patch("Updated")).name)
        assertEquals("Updated", api.users.read().name)
    }
}
