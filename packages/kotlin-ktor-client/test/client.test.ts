import { describe, expect, it } from "vitest";
import { client, HEADER, Tester, TARGET } from "./tester.js";

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
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod
import io.ktor.http.contentType
import io.ktor.http.isSuccess

class PetsClient(
    private val http: HttpClient,
    private val baseUrl: String,
) {
    suspend fun get(petId: Long, trace: String? = null): Pet {
        return executeApiRequest(http, baseUrl, HttpMethod.Get, listOf("pets", petId.toString()), {
            trace?.let { header("x-trace", it) }
        }, { response ->
            if (response.status.isSuccess()) {
                return@executeApiRequest response.body()
            }
            if (response.isProblem()) throw ApiException(response.status.value, response.errorMessage())
            throw when (response.status.value) {
                404 -> NotFoundException(response.body(), response.status.value)
                else -> ApiErrorException(response.body(), response.status.value)
            }
        })
    }

`)).toBe(true);
  });

  it("maps sealed results, bodies and response headers", async () => {
    const { outputs } = await client().compile(spec);
    expect(outputs[`${DIR}/PetsClient.kt`]).toContain(`
    suspend fun create(pet: Pet): CreateResult {
        return executeApiRequest(http, baseUrl, HttpMethod.Post, listOf("pets"), {
            contentType(ContentType.parse("application/json"))
            setBody(pet)
        }, { response ->
            when (response.status.value) {
                201 -> return@executeApiRequest CreateResult.Created(response.body(), (response.headers["location"] ?: throw ApiException(response.status.value, "missing header location")))
                200 -> return@executeApiRequest CreateResult.Ok(response.body())
            }
            throw when (response.status.value) {
                else -> ApiException(response.status.value, response.errorMessage())
            }
        })
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
    expect(pets).toContain(`            if (response.status.isSuccess()) {
                return@executeApiRequest
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
 * JSON of the PetStore API: the models' serializers and this target's \`features.ignore-unknown-keys\` /
 * \`features.encode-defaults\`. Derive your own with \`Json(PetStoreJson) { … }\` and pass it to \`petStoreDefaults(format)\`.
 */
val PetStoreJson: Json = Json {
    ignoreUnknownKeys = true
}

/**
 * Installs JSON content negotiation compatible with the generated models.
 */
fun HttpClientConfig<*>.petStoreDefaults(format: Json = PetStoreJson) {
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

  it("marks generated declarations internal with the emitter's visibility: internal", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-kotlin", {
      package: "com.acme",
      visibility: "internal",
      targets: [{ [TARGET]: {} }],
    }).compile(`
      @service namespace PetStore;
      model Pet { id: int64 }
      @route("/pets") interface Pets { @get list(): Pet[]; }
    `);
    expect(outputs[`${DIR}/PetsClient.kt`]).toContain("\ninternal class PetsClient(");
    const api = outputs[`${DIR}/PetStoreApiClient.kt`];
    expect(api).toContain("\ninternal class PetStoreApiClient(http: HttpClient, baseUrl: String) {");
    expect(api).toMatch(/\ninternal fun HttpClientConfig<\*>\.\w+\(/);
  });
});

describe("Kotlin client wire behavior", () => {
  it("uses raw bytes for binary HTTP bodies and keeps JSON bytes as base64 strings", async () => {
    const { outputs } = await client().compile(`
      @service namespace S;
      model Encoded { value: bytes }
      @get @route("/binary") op binary(): { @header contentType: "application/octet-stream"; @body body: bytes; };
      @put @route("/binary") op upload(@header contentType: "application/octet-stream", @body body: bytes): void;
      @get @route("/encoded") op encoded(): Encoded;
    `);
    expect(outputs[`${DIR}/SClient.kt`]).toContain(
      "suspend fun binary(): ByteArray",
    );
    expect(outputs[`${DIR}/SClient.kt`]).toContain(
      "suspend fun upload(contentType: String, body: ByteArray)",
    );
    expect(outputs["models/com/acme/models/Encoded.kt"]).toContain(
      "val value: String",
    );
  });

  it("shares transport and authentication plans while resolving providers per call", async () => {
    const { outputs } = await client().compile(`
      @service @useAuth(BearerAuth) namespace S;
      @get @route("/a") op a(): string;
      @get @route("/b") op b(): string;
    `);
    const group = outputs[`${DIR}/SClient.kt`];
    expect(group).toContain("private val authPlan1 = listOf(");
    expect(group).not.toContain("private val authPlan2");
    expect(group.match(/resolveAuth\(this@SClient.authPlan1\)/g)).toHaveLength(
      2,
    );
    expect(group.match(/return executeApiRequest/g)).toHaveLength(2);
    expect(group).toContain("return@executeApiRequest response.body()");
    expect(outputs[`${DIR}/ClientSupport.kt`]).toContain(
      "}.execute { response -> decode(response) }",
    );
  });

  it("adds scoped binary streaming without changing the buffered method", async () => {
    const { outputs } = await client({ features: { streaming: true } })
      .compile(`
      @service namespace S;
      @get @route("/binary") op binary(): { @header contentType: "application/octet-stream"; @body body: bytes; };
    `);
    const group = outputs[`${DIR}/SClient.kt`];
    expect(group).toContain("suspend fun binary(): ByteArray");
    expect(group).toContain(
      "suspend fun <StreamResult> binaryStream(consume: suspend (ByteReadChannel) -> StreamResult)",
    );
    expect(group).toContain("return@execute consume(response.bodyAsChannel())");
  });

  it("enforces configured byte limits inside scoped requests, including chunked errors", async () => {
    const { outputs } = await client({
      "max-response-size": 64,
      "max-error-size": 32,
    }).compile(`
      @service namespace S; @get op value(): string;
    `);
    expect(outputs[`${DIR}/SClient.kt`]).toContain(
      "http.readApiBody<String>(response)",
    );
    const runtime = outputs[`${DIR}/ClientSupport.kt`];
    expect(runtime).toContain("if (status.isSuccess()) 64 else 32");
    expect(runtime).toContain("readRemaining(limit.toLong() + 1)");
    expect(runtime).toContain("throw ApiException(status.value");
  });

  it("disambiguates streaming methods and preserves strings containing return", async () => {
    const { outputs } = await client({ features: { streaming: true } })
      .compile(`
      @service namespace S;
      @get @route("/bytes") op binary(): { @header contentType: "application/octet-stream"; @body body: bytes; };
      @get @route("/existing") op binaryStream(): { @header("return") value: string; };
    `);
    const code = outputs[`${DIR}/SClient.kt`];
    expect(code).toContain("suspend fun <StreamResult> binaryStream2(");
    expect(code).toContain("missing header return");
    expect(code).not.toContain("missing header return@executeApiRequest");
  });
});
