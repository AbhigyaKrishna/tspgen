import { describe, expect, it } from "vitest";
import { HEADER, petSpec, server } from "./tester.js";

const DIR = "server/com/acme/server";

const javaTimeSpec = `
  @service namespace S;
  model Slot { at: utcDateTime }
  @route("/slots") op list(): Slot[];
`;

const jsonPartSpec = `
  @service namespace S;
  model Meta { title: string }
  model Form { meta: HttpPart<Meta>; }
  @post op send(@header contentType: "multipart/form-data", @multipartBody body: Form): void;
`;

describe("ktor server json", () => {
  it("declares serverJson on Ktor's DefaultJson without encoding defaults, and the module installs it", async () => {
    const { outputs } = await server().compile(petSpec);
    const support = outputs[`${DIR}/ServerSupport.kt`];
    expect(support).toContain("val serverJson: Json = Json(DefaultJson) {\n    encodeDefaults = false\n}\n");
    expect(support).toContain("import io.ktor.serialization.kotlinx.json.DefaultJson\n");
    expect(outputs[`${DIR}/PetStoreModule.kt`]).toContain("        json(serverJson)\n");
  });

  it("applies encode-defaults and ignore-unknown-keys", async () => {
    const { outputs } = await server({ features: { "encode-defaults": true, "ignore-unknown-keys": true } }).compile(petSpec);
    expect(outputs[`${DIR}/ServerSupport.kt`]).toContain(
      "val serverJson: Json = Json(DefaultJson) {\n    encodeDefaults = true\n    ignoreUnknownKeys = true\n}\n",
    );
  });

  it("keeps DefaultJson's settings when java.time serializers are needed", async () => {
    const { outputs } = await server().compile(javaTimeSpec);
    const support = outputs[`${DIR}/ServerSupport.kt`];
    expect(support).toContain(
      "val serverJson: Json = Json(DefaultJson) {\n    encodeDefaults = false\n    serializersModule = modelSerializersModule\n}\n",
    );
    expect(support).toContain("import com.acme.models.modelSerializersModule\n");
    const module = outputs[`${DIR}/SModule.kt`];
    expect(module).toContain("        json(serverJson)\n");
    expect(module).not.toContain("modelSerializersModule");
    expect(module).not.toContain("import kotlinx.serialization.json.Json\n");
  });

  it("declares serverJson without the module too, for the application's own content negotiation", async () => {
    const plain = (await server({ features: { module: false, "encode-defaults": true } }).compile(petSpec)).outputs;
    expect(plain[`${DIR}/ServerSupport.kt`]).toContain(
      "val serverJson: Json = Json(DefaultJson) {\n    encodeDefaults = true\n",
    );
    expect(plain[`${DIR}/ServerSupport.kt`]).toContain("import io.ktor.serialization.kotlinx.json.DefaultJson\n");
    const parts = (await server({ features: { module: false } }).compile(jsonPartSpec)).outputs;
    expect(parts[`${DIR}/ServerSupport.kt`]).toContain("val serverJson: Json = Json(DefaultJson) {");
    expect(parts[`${DIR}/SRoutes.kt`]).toContain('convertParam("meta") { serverJson.decodeFromString<Meta>(it) }');
  });

  it("imports serverJson into routes of mapped packages", async () => {
    const { outputs } = await server({}, { packages: [{ namespace: "S.Forms", package: "com.acme.forms" }] }).compile(`
      @service namespace S;
      model Meta { title: string }
      model Form { meta: HttpPart<Meta>; }
      namespace Forms {
        @post op send(@header contentType: "multipart/form-data", @multipartBody body: Form): void;
      }
    `);
    expect(outputs["server/com/acme/forms/FormsRoutes.kt"]).toContain("import com.acme.server.serverJson\n");
  });
});

describe("ktor server errors", () => {
  it("emits <Service>Errors.kt with problem bodies for unmapped errors, 400, 413 and 415", async () => {
    const { outputs } = await server().compile(petSpec);
    expect(outputs[`${DIR}/PetStoreErrors.kt`]).toBe(`${HEADER}
package com.acme.server

import com.acme.api.ApiErrorException
import com.acme.api.ApiException
import io.ktor.http.HttpStatusCode
import io.ktor.server.plugins.BadRequestException
import io.ktor.server.plugins.ContentTransformationException
import io.ktor.server.plugins.PayloadTooLargeException
import io.ktor.server.plugins.statuspages.StatusPagesConfig
import io.ktor.server.request.contentType
import io.ktor.server.response.respond

/**
 * Maps the PetStore API's exceptions to responses. A handler registered after this call replaces the one here for
 * the same exception class.
 */
fun StatusPagesConfig.petStoreErrors() {
    exception<ApiErrorException> { call, cause ->
        call.respond(HttpStatusCode.fromValue(cause.status), cause.error)
    }
    exception<ApiException> { call, cause ->
        call.respondProblem(HttpStatusCode.fromValue(cause.status), cause.message)
    }
    exception<BadRequestException> { call, cause ->
        call.respondProblem(HttpStatusCode.BadRequest, cause.problemDetail())
    }
    exception<PayloadTooLargeException> { call, cause ->
        call.respondProblem(HttpStatusCode.PayloadTooLarge, cause.message)
    }
    exception<ContentTransformationException> { call, _ ->
        call.respondProblem(HttpStatusCode.UnsupportedMediaType, "Content type \${call.request.contentType()} is not supported")
    }
}
`);
    const support = outputs[`${DIR}/ServerSupport.kt`];
    expect(support).toContain(`internal suspend fun ApplicationCall.respondProblem(status: HttpStatusCode, detail: String?) {
    val problem = buildJsonObject {
        put("type", "about:blank")
        put("title", status.description)
        put("status", status.value)
        if (detail != null) put("detail", detail)
    }
    respondText(problem.toString(), ContentType.Application.ProblemJson, status)
}`);
    expect(support).toContain(`@OptIn(ExperimentalSerializationApi::class) // MissingFieldException.missingFields
internal fun BadRequestException.problemDetail(): String? {
    if (this is MissingRequestParameterException || this is ParameterConversionException) return message
    val causes = generateSequence(cause) { it.cause }.toList()
    val innermost = causes.lastOrNull() ?: return message
    // A copy of our own exception (coroutines' stack-trace recovery chains the original as its cause), or a model check.
    if (innermost is BadRequestException || (innermost is IllegalArgumentException && innermost !is SerializationException)) {
        return innermost.message
    }
    val missing = causes.filterIsInstance<MissingFieldException>().lastOrNull()?.missingFields.orEmpty()
    val path = causes.lastOrNull { it is SerializationException }?.message?.let { JSON_PATH.find(it)?.groupValues?.get(1) }
    return buildString {
        append("Malformed request body")
        if (missing.isNotEmpty()) append(missing.joinToString(prefix = ": missing ") { "'$it'" })
        if (path != null) append(" at path ").append(path)
    }
}`);
    // kotlinx's messages name model classes and echo the request body: never sent.
    expect(support).not.toContain("lastOrNull()?.message");
    for (const i of ["io.ktor.http.ContentType", "kotlinx.serialization.ExperimentalSerializationApi", "kotlinx.serialization.MissingFieldException", "kotlinx.serialization.SerializationException", "io.ktor.server.response.respondText", "kotlinx.serialization.json.buildJsonObject", "kotlinx.serialization.json.put"]) {
      expect(support).toContain(`import ${i}\n`);
    }
  });

  it("keeps 0.1.x's empty responses with error-body: none", async () => {
    const { outputs } = await server({ "error-body": "none" }).compile(petSpec);
    const errors = outputs[`${DIR}/PetStoreErrors.kt`];
    expect(errors).toContain(`    exception<ApiException> { call, cause ->
        call.respond(HttpStatusCode.fromValue(cause.status))
    }
}
`);
    expect(errors).not.toContain("BadRequestException");
    expect(errors).not.toContain("PayloadTooLargeException");
    expect(outputs[`${DIR}/ServerSupport.kt`]).not.toContain("respondProblem");
  });

  it("installs StatusPages in the module unless status-pages is off", async () => {
    const on = (await server().compile(petSpec)).outputs[`${DIR}/PetStoreModule.kt`];
    expect(on).toContain("    install(StatusPages) {\n        petStoreErrors()\n    }\n");
    expect(on).not.toContain("StatusPagesConfig");
    const off = (await server({ features: { "status-pages": false } }).compile(petSpec)).outputs;
    expect(off[`${DIR}/PetStoreModule.kt`]).not.toContain("StatusPages");
    expect(off[`${DIR}/PetStoreModule.kt`]).toContain(" * Installs content negotiation and all PetStore routes.\n");
    expect(off[`${DIR}/PetStoreErrors.kt`]).toContain("fun StatusPagesConfig.petStoreErrors() {");
  });

  it("emits the errors file without the module", async () => {
    const { outputs } = await server({ features: { module: false } }).compile(petSpec);
    expect(outputs[`${DIR}/PetStoreModule.kt`]).toBeUndefined();
    expect(outputs[`${DIR}/PetStoreErrors.kt`]).toContain("fun StatusPagesConfig.petStoreErrors() {");
    expect(outputs[`${DIR}/ServerSupport.kt`]).toContain("respondProblem");
  });

  it("follows visibility: internal", async () => {
    const { outputs } = await server({}, { visibility: "internal" }).compile(petSpec);
    expect(outputs[`${DIR}/PetStoreErrors.kt`]).toContain("\ninternal fun StatusPagesConfig.petStoreErrors() {");
    expect(outputs[`${DIR}/ServerSupport.kt`]).toContain("\ninternal val serverJson: Json = Json(DefaultJson) {");
  });

  it("declares serverJson public by default, for content negotiation installed in another module", async () => {
    const { outputs } = await server({ features: { module: false } }).compile(petSpec);
    expect(outputs[`${DIR}/ServerSupport.kt`]).toContain(" */\nval serverJson: Json = Json(DefaultJson) {");
  });
});
