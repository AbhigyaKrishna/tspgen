import { describe, expect, it } from "vitest";
import { client, HEADER } from "./tester.js";

const DIR = "client/com/acme/client";

const spec = `
  @service namespace PetStore;
  model Pet { id: int64; name: string }
  enum Kind { dog, cat }
  @error model ApiError { code: string }
  @error model NotFound { @statusCode _: 404; message: string }
  @route("/pets") interface Pets {
    @get get(@path petId: int64, @header("x-trace") trace?: string): Pet | NotFound | ApiError;
    @post create(@body pet: Pet): { @statusCode _: 201; @header location: string; @body pet: Pet } | { @statusCode _: 200; @body pet: Pet };
    @get search(@query kind?: Kind, @query ids: int32[], @query(#{ explode: true }) tags?: string[]): Pet[];
    @delete remove(@path petId: int64): void;
  }
`;

describe("ktor client", () => {
  it("emits a client class per group", async () => {
    const { outputs } = await client().compile(spec);
    const pets = outputs[`${DIR}/PetsClient.kt`];
    expect(pets.startsWith(`${HEADER}
package com.acme.client

import com.acme.api.ApiErrorException
import com.acme.api.ApiException
import com.acme.api.CreateResult
import com.acme.api.NotFoundException
import com.acme.models.Kind
import com.acme.models.Pet
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.header
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod
import io.ktor.http.appendPathSegments
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.http.takeFrom

class PetsClient(
    private val http: HttpClient,
    private val baseUrl: String,
) {
    suspend fun get(petId: Long, trace: String? = null): Pet {
        val response = http.request {
            method = HttpMethod.Get
            url {
                takeFrom(baseUrl)
                appendPathSegments("pets", petId.toString())
            }
            trace?.let { header("x-trace", it) }
        }
        if (response.status.isSuccess()) {
            return response.body()
        }
        throw when (response.status.value) {
            404 -> NotFoundException(response.body(), response.status.value)
            else -> ApiErrorException(response.body(), response.status.value)
        }
    }
`)).toBe(true);
  });

  it("maps sealed results, bodies and response headers", async () => {
    const { outputs } = await client().compile(spec);
    expect(outputs[`${DIR}/PetsClient.kt`]).toContain(`
    suspend fun create(pet: Pet): CreateResult {
        val response = http.request {
            method = HttpMethod.Post
            url {
                takeFrom(baseUrl)
                appendPathSegments("pets")
            }
            contentType(ContentType.parse("application/json"))
            setBody(pet)
        }
        when (response.status.value) {
            201 -> return CreateResult.Created(response.body(), (response.headers["location"] ?: throw ApiException(response.status.value, "missing header location")))
            200 -> return CreateResult.Ok(response.body())
        }
        throw when (response.status.value) {
            else -> ApiException(response.status.value, response.bodyAsText())
        }
    }
`);
  });

  it("encodes query parameters", async () => {
    const { outputs } = await client().compile(spec);
    const pets = outputs[`${DIR}/PetsClient.kt`];
    expect(pets).toContain(`kind?.let { parameters.append("kind", encodeParam(it)) }`);
    expect(pets).toContain(`parameters.append("ids", ids.joinToString(",") { it.toString() })`);
    expect(pets).toContain(`tags?.forEach { parameters.append("tags", it) }`);
    expect(pets).toContain(`    suspend fun remove(petId: Long) {`);
    expect(pets).toContain(`        if (response.status.isSuccess()) {
            return
        }`);
  });

  it("writes and parses java.time parameters and headers as ISO-8601", async () => {
    const { outputs } = await client().compile(`
      @service namespace S;
      @route("/slots") op list(@path day: plainDate, @query at: utcDateTime[], @header("x-length") length?: duration): {
        @header("x-next") next: utcDateTime;
      };
    `);
    const code = outputs[`${DIR}/SClient.kt`];
    expect(code).toContain(`day.toString()`);
    expect(code).toContain(`parameters.append("at", at.joinToString(",") { it.toString() })`);
    expect(code).toContain(`length?.let { header("x-length", it.toString()) }`);
    expect(code).toContain(`Instant.parse((response.headers["x-next"] ?: throw`);
  });

  it("emits the aggregate client and support helpers", async () => {
    const { outputs } = await client().compile(spec);
    expect(outputs[`${DIR}/PetStoreApiClient.kt`]).toBe(`${HEADER}
package com.acme.client

import io.ktor.client.HttpClient
import io.ktor.client.HttpClientConfig
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json

/**
 * Entry point for the PetStore API.
 */
class PetStoreApiClient(http: HttpClient, baseUrl: String) {
    val pets = PetsClient(http, baseUrl)
}

/**
 * Installs JSON content negotiation compatible with the generated models.
 */
fun HttpClientConfig<*>.petStoreDefaults(format: Json = Json) {
    install(ContentNegotiation) {
        json(format)
    }
}
`);
    expect(outputs[`${DIR}/ClientSupport.kt`]).toContain("internal inline fun <reified T> encodeParam(value: T): String =");
  });

  it("honours the package option", async () => {
    const { outputs } = await client({ package: "com.acme.sdk" }).compile(spec);
    expect(outputs["client/com/acme/sdk/PetsClient.kt"]).toContain("package com.acme.sdk\n");
  });
});
