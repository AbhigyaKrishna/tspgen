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

  it("sets explicitNulls = false with features.explicit-nulls: false", async () => {
    const on = (await server().compile(petSpec)).outputs[`${DIR}/ServerSupport.kt`];
    expect(on).not.toContain("explicitNulls");
    const off = (await server({ features: { "explicit-nulls": false, "ignore-unknown-keys": true } }).compile(petSpec))
      .outputs[`${DIR}/ServerSupport.kt`];
    expect(off).toContain(
      "@OptIn(ExperimentalSerializationApi::class) // explicitNulls\nval serverJson: Json = Json(DefaultJson) {\n    encodeDefaults = false\n    ignoreUnknownKeys = true\n    explicitNulls = false\n}\n",
    );
  });
});

describe("ktor server errors", () => {
  it("emits <Service>Errors.kt: declared bodies, every other error through the responder", async () => {
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
import io.ktor.server.response.respond

/**
 * Maps the PetStore API's exceptions to responses. Typed exceptions answer their declared body; every other error the
 * generated routes raise goes to [responder] as a [ServerError] (default: an RFC 9457 problem). A handler registered
 * after this call replaces the one here for the same exception class.
 */
fun StatusPagesConfig.petStoreErrors(responder: ServerErrorResponder = { respondProblem(it.status, it.detail) }) {
    exception<ApiErrorException> { call, cause ->
        call.respond(HttpStatusCode.fromValue(cause.status), cause.error)
    }
    exception<ApiException> { call, cause ->
        responder(call, call.serverErrorOf(cause)!!)
    }
    exception<BadRequestException> { call, cause ->
        responder(call, call.serverErrorOf(cause)!!)
    }
    exception<PayloadTooLargeException> { call, cause ->
        responder(call, call.serverErrorOf(cause)!!)
    }
    exception<ContentTransformationException> { call, cause ->
        responder(call, call.serverErrorOf(cause)!!)
    }
}
`);
    const support = outputs[`${DIR}/ServerSupport.kt`];
    expect(support).toContain(`suspend fun ApplicationCall.respondProblem(status: HttpStatusCode, detail: String?) {
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
    if (this is MissingRequestParameterException || this is ParameterConversionException || cause == null) return message
    sendableCause()?.let { return it.message }
    val causes = generateSequence(cause) { it.cause }.toList()
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

  it("answers status-only by default with error-body: none", async () => {
    const { outputs } = await server({ "error-body": "none" }).compile(petSpec);
    const errors = outputs[`${DIR}/PetStoreErrors.kt`];
    expect(errors).toContain(
      "fun StatusPagesConfig.petStoreErrors(responder: ServerErrorResponder = { respond(it.status) }) {\n",
    );
    // The 400/413/415 handlers are registered too, so a custom responder sees them.
    for (const e of ["BadRequestException", "PayloadTooLargeException", "ContentTransformationException"]) {
      expect(errors).toContain(`    exception<${e}> { call, cause ->\n        responder(call, call.serverErrorOf(cause)!!)\n    }\n`);
    }
    expect(errors).toContain("import io.ktor.server.response.respond\n");
    expect(outputs[`${DIR}/ServerSupport.kt`]).toContain("\nsuspend fun ApplicationCall.respondProblem(");
  });

  it("imports HttpStatusCode into the errors file only for typed exceptions", async () => {
    const { outputs } = await server().compile(`
      @service namespace S;
      @route("/x") op get(): string;
    `);
    const errors = outputs[`${DIR}/SErrors.kt`];
    expect(errors).not.toContain("import io.ktor.http.HttpStatusCode\n");
    expect(errors).not.toContain("import io.ktor.server.response.respond\n");
    expect(errors).toContain("    exception<ApiException> { call, cause ->\n");
  });

  it("installs StatusPages in the module unless status-pages is off", async () => {
    const on = (await server().compile(petSpec)).outputs[`${DIR}/PetStoreModule.kt`];
    expect(on).toContain("    install(StatusPages) {\n        petStoreErrors()\n    }\n");
    expect(on).not.toContain("StatusPagesConfig");
    const off = (await server({ features: { "status-pages": false } }).compile(petSpec)).outputs;
    expect(off[`${DIR}/PetStoreModule.kt`]).not.toContain("StatusPages");
    expect(off[`${DIR}/PetStoreModule.kt`]).toContain(" * Installs content negotiation and all PetStore routes.\n");
    expect(off[`${DIR}/PetStoreErrors.kt`]).toContain("fun StatusPagesConfig.petStoreErrors(responder: ServerErrorResponder");
  });

  it("emits the errors file without the module", async () => {
    const { outputs } = await server({ features: { module: false } }).compile(petSpec);
    expect(outputs[`${DIR}/PetStoreModule.kt`]).toBeUndefined();
    expect(outputs[`${DIR}/PetStoreErrors.kt`]).toContain("fun StatusPagesConfig.petStoreErrors(responder: ServerErrorResponder");
    expect(outputs[`${DIR}/ServerSupport.kt`]).toContain("respondProblem");
  });

  it("follows visibility: internal", async () => {
    const { outputs } = await server({}, { visibility: "internal" }).compile(petSpec);
    expect(outputs[`${DIR}/PetStoreErrors.kt`]).toContain("\ninternal fun StatusPagesConfig.petStoreErrors(responder: ServerErrorResponder");
    expect(outputs[`${DIR}/ServerSupport.kt`]).toContain("\ninternal val serverJson: Json = Json(DefaultJson) {");
    const support = outputs[`${DIR}/ServerSupport.kt`];
    expect(support).toContain("\ninternal class ServerError internal constructor(");
    expect(support).toContain("\ninternal enum class ServerErrorKind {");
    expect(support).toContain("\ninternal typealias ServerErrorResponder =");
    expect(support).toContain("\ninternal fun ApplicationCall.serverErrorOf(");
    expect(support).toContain("\ninternal suspend fun ApplicationCall.respondProblem(");
  });

  it("declares serverJson public by default, for content negotiation installed in another module", async () => {
    const { outputs } = await server({ features: { module: false } }).compile(petSpec);
    expect(outputs[`${DIR}/ServerSupport.kt`]).toContain(" */\nval serverJson: Json = Json(DefaultJson) {");
  });

  it("skips <Service>Errors.kt and the module's StatusPages with features.errors: false", async () => {
    const { outputs } = await server({ features: { errors: false } }).compile(petSpec);
    expect(outputs[`${DIR}/PetStoreErrors.kt`]).toBeUndefined();
    expect(outputs[`${DIR}/PetStoreModule.kt`]).not.toContain("StatusPages");
    expect(outputs[`${DIR}/PetStoreModule.kt`]).toContain(" * Installs content negotiation and all PetStore routes.\n");
    // Nothing generated needs ktor-server-status-pages.
    for (const [path, text] of Object.entries(outputs)) expect(text, path).not.toContain("statuspages");
  });

  it("declares ServerError, its kinds and serverErrorOf for every error-body and feature combination", async () => {
    for (const options of [{}, { "error-body": "none" }, { features: { module: false, errors: false } }]) {
      const support = (await server(options).compile(petSpec)).outputs[`${DIR}/ServerSupport.kt`];
      expect(support).toContain(`class ServerError internal constructor(
    val status: HttpStatusCode,
    val detail: String?,
    val kind: ServerErrorKind,
    val cause: Throwable,
)`);
      expect(support).toContain("\nenum class ServerErrorKind {\n");
      for (const kind of ["MissingParameter", "InvalidParameter", "MalformedBody", "FailedCheck", "PayloadTooLarge", "UnsupportedMediaType", "ApiException"]) {
        expect(support).toContain(`    ${kind},\n`);
      }
      expect(support).toContain("\ntypealias ServerErrorResponder = suspend ApplicationCall.(ServerError) -> Unit\n");
      expect(support).toContain("\nfun ApplicationCall.serverErrorOf(cause: Throwable): ServerError? =\n");
      expect(support).toContain(
        "        is ApiException ->\n            ServerError(HttpStatusCode.fromValue(cause.status), cause.message, ServerErrorKind.ApiException, cause)\n",
      );
      expect(support).toContain("\nsuspend fun ApplicationCall.respondProblem(status: HttpStatusCode, detail: String?) {");
      expect(support).toContain("\ninternal fun BadRequestException.problemDetail(): String? {");
      expect(support).not.toContain("data class ServerError");
      for (const i of ["com.acme.api.ApiException", "io.ktor.server.plugins.PayloadTooLargeException", "io.ktor.server.plugins.ContentTransformationException", "io.ktor.server.request.contentType"]) {
        expect(support).toContain(`import ${i}\n`);
      }
    }
  });

  it("classifies 400s: ModelCheckException as FailedCheck, everything else as MalformedBody", async () => {
    const { outputs } = await server().compile(`
      @service namespace S;
      model Item { @maxLength(5) name: string }
      @post op create(@body item: Item): void;
    `);
    const support = outputs[`${DIR}/ServerSupport.kt`];
    expect(outputs["models/com/acme/models/ModelCheckException.kt"]).toBeDefined();
    expect(support).toContain("import com.acme.models.ModelCheckException\n");
    expect(support).toContain(`private fun badRequestError(cause: BadRequestException): ServerError {
    val kind = if (cause.sendableCause() is ModelCheckException) ServerErrorKind.FailedCheck else ServerErrorKind.MalformedBody
    return ServerError(HttpStatusCode.BadRequest, cause.problemDetail(), kind, cause)
}`);
    // Only a model check or our own BadRequestException is sent: a deserializer's IllegalArgumentException echoes input.
    expect(support).toContain(`private fun BadRequestException.sendableCause(): Throwable? =
    generateSequence(cause) { it.cause }.lastOrNull()?.takeIf { it is ModelCheckException || it is BadRequestException }
`);
    expect(support).not.toContain("is IllegalArgumentException");
    expect(support).toContain("    sendableCause()?.let { return it.message }\n");
  });

  it("never references ModelCheckException when no model has a check", async () => {
    const { outputs } = await server().compile(petSpec);
    expect(outputs["models/com/acme/models/ModelCheckException.kt"]).toBeUndefined();
    const support = outputs[`${DIR}/ServerSupport.kt`];
    for (const [path, text] of Object.entries(outputs)) expect(text, path).not.toContain("ModelCheckException");
    expect(support).toContain(`private fun badRequestError(cause: BadRequestException): ServerError =
    ServerError(HttpStatusCode.BadRequest, cause.problemDetail(), ServerErrorKind.MalformedBody, cause)
`);
    expect(support).toContain(`private fun BadRequestException.sendableCause(): Throwable? =
    generateSequence(cause) { it.cause }.lastOrNull()?.takeIf { it is BadRequestException }
`);
    expect(support).not.toContain("is IllegalArgumentException");
  });
});
