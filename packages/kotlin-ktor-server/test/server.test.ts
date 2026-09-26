import { describe, expect, it } from "vitest";
import { HEADER, petSpec, server } from "./tester.js";

const DIR = "server/com/acme/server";

describe("ktor server (dsl)", () => {
  it("emits the service interface", async () => {
    const { outputs } = await server().compile(petSpec);
    expect(outputs[`${DIR}/PetsService.kt`]).toBe(`${HEADER}
package com.acme.server

import com.acme.api.CreateResult
import com.acme.models.Pet

interface PetsService {
    suspend fun list(limit: Int?, tags: List<String>?): List<Pet>
    suspend fun get(petId: Long, trace: String?): Pet
    suspend fun create(pet: Pet): CreateResult
    suspend fun remove(petId: Long)
}
`);
  });

  it("emits DSL routes", async () => {
    const { outputs } = await server().compile(petSpec);
    expect(outputs[`${DIR}/PetsRoutes.kt`]).toBe(`${HEADER}
package com.acme.server

import com.acme.api.CreateResult
import com.acme.models.Pet
import io.ktor.http.HttpStatusCode
import io.ktor.server.request.receive
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.post

fun Route.petsRoutes(service: PetsService) {
    get("/pets") {
        val limit = call.queryParam("limit")?.convertParam("limit") { it.toInt() }
        val tags = call.queryParams("tags").takeIf { it.isNotEmpty() }
        call.respond(HttpStatusCode.OK, service.list(limit, tags))
    }
    get("/pets/{petId}") {
        val petId = call.pathParam("petId").convertParam("petId") { it.toLong() }
        val trace = call.headerParam("x-trace")
        call.respond(HttpStatusCode.OK, service.get(petId, trace))
    }
    post("/pets") {
        val pet = call.receive<Pet>()
        when (val result = service.create(pet)) {
            is CreateResult.Created -> {
                call.response.header("location", result.location)
                call.respond(HttpStatusCode.Created, result.body)
            }
            is CreateResult.Ok -> {
                call.respond(HttpStatusCode.OK, result.body)
            }
        }
    }
    delete("/pets/{petId}") {
        val petId = call.pathParam("petId").convertParam("petId") { it.toLong() }
        service.remove(petId)
        call.respond(HttpStatusCode.NoContent)
    }
}
`);
  });

  it("emits the application module with error mapping", async () => {
    const { outputs } = await server().compile(petSpec);
    expect(outputs[`${DIR}/PetStoreModule.kt`]).toBe(`${HEADER}
package com.acme.server

import com.acme.api.ApiErrorException
import com.acme.api.ApiException
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.plugins.statuspages.StatusPagesConfig
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.routing

/**
 * Installs content negotiation, error handling and all PetStore routes.
 */
fun Application.petStoreModule(petsService: PetsService) {
    install(ContentNegotiation) {
        json()
    }
    install(StatusPages) {
        petStoreErrors()
    }
    routing {
        petStoreApiRoutes(petsService)
    }
}

fun Route.petStoreApiRoutes(petsService: PetsService) {
    petsRoutes(petsService)
}

fun StatusPagesConfig.petStoreErrors() {
    exception<ApiErrorException> { call, cause ->
        call.respond(HttpStatusCode.fromValue(cause.status), cause.error)
    }
    exception<ApiException> { call, cause ->
        call.respond(HttpStatusCode.fromValue(cause.status))
    }
}
`);
  });

  it("emits parameter support helpers once", async () => {
    const { outputs } = await server().compile(petSpec);
    const support = outputs[`${DIR}/ServerSupport.kt`];
    expect(support).toContain("internal fun ApplicationCall.pathParam(name: String): String =");
    expect(support).toContain("internal inline fun <reified T> decodeParam(raw: String): T");
  });

  it("encodes typed response headers with their wire representation", async () => {
    const { outputs } = await server().compile(`
      @service namespace S;
      enum Kind { a, b }
      @route("/items") op make(): { @statusCode _: 201; @header kind: Kind; @header count?: int32 } | { @statusCode _: 200 };
    `);
    const routes = outputs[`${DIR}/SRoutes.kt`];
    expect(routes).toContain(`call.response.header("kind", encodeParam(result.kind))`);
    expect(routes).toContain(`result.count?.let { call.response.header("count", it.toString()) }`);
  });

  it("converts non-primitive parameters through kotlinx", async () => {
    const { outputs } = await server().compile(`
      @service namespace S;
      enum Kind { a, b }
      @route("/items") op list(@query kind: Kind, @query since?: utcDateTime, @query ids: int32[]): void;
    `);
    const routes = outputs[`${DIR}/SRoutes.kt`];
    expect(routes).toContain(`val kind = call.queryParam("kind").required("kind").convertParam("kind") { decodeParam<Kind>(it) }`);
    expect(routes).toContain(`val since = call.queryParam("since")?.convertParam("since") { Instant.parse(it) }`);
    expect(routes).toContain(`val ids = (call.queryParam("ids")?.split(",")?.map { it.convertParam("ids") { it.toInt() } }).required("ids")`);
  });

  it("parses and writes java.time parameters and headers as ISO-8601; kotlin.time goes through kotlinx", async () => {
    const spec = `
      @service namespace S;
      @route("/slots") op list(@path day: plainDate, @query at: utcDateTime[], @header("x-length") length?: duration): {
        @header("x-next") next: utcDateTime;
      };
    `;
    const java = (await server().compile(spec)).outputs[`${DIR}/SRoutes.kt`];
    expect(java).toContain(`val day = call.pathParam("day").convertParam("day") { LocalDate.parse(it) }`);
    expect(java).toContain(`?.map { it.convertParam("at") { Instant.parse(it) } }`);
    expect(java).toContain(`val length = call.headerParam("x-length")?.convertParam("x-length") { Duration.parse(it) }`);
    expect(java).toContain(`call.response.header("x-next", result.next.toString())`);
    const kotlin = (await server({}, { "date-time": "kotlin.time" }).compile(spec)).outputs[`${DIR}/SRoutes.kt`];
    expect(kotlin).toContain(`{ decodeParam<LocalDate>(it) }`);
    expect(kotlin).toContain(`call.response.header("x-next", encodeParam(result.next))`);
  });
});
