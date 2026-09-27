import { expectDiagnostics } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { HEADER, petSpec, server } from "./tester.js";

const DIR = "server/com/acme/server";

const uploadSpec = `
  @service namespace S;
  model Meta { title: string }
  model Upload {
    name: HttpPart<string>;
    count?: HttpPart<int32>;
    meta: HttpPart<Meta>;
    avatar: HttpPart<File>;
    photos?: HttpPart<File<"image/png">>[];
  }
  @route("/uploads") interface Uploads {
    @post upload(@header contentType: "multipart/form-data", @multipartBody body: Upload): void;
    @put @route("/file") file(@bodyRoot file: File): void;
  }
`;

describe("ktor server uploads", () => {
  it("buffers multipart parts into the request class and file bodies into HttpFile by default", async () => {
    const { outputs } = await server().compile(uploadSpec);
    expect(outputs[`${DIR}/UploadsService.kt`]).toBe(`${HEADER}
package com.acme.server

import com.acme.models.HttpFile
import com.acme.models.Upload

interface UploadsService {
    suspend fun upload(body: Upload)
    suspend fun file(file: HttpFile)
}
`);
    expect(outputs[`${DIR}/UploadsRoutes.kt`]).toBe(`${HEADER}
package com.acme.server

import com.acme.models.Meta
import com.acme.models.Upload
import io.ktor.http.HttpStatusCode
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import io.ktor.server.routing.put

fun Route.uploadsRoutes(service: UploadsService) {
    post("/uploads") {
        val body = call.receiveParts(52428800L, setOf("name", "count", "meta"), setOf("avatar", "photos"), multiParts = setOf("photos")).let { parts ->
            Upload(
                name = parts.text("name").required("name"),
                count = parts.text("count")?.convertParam("count") { it.toInt() },
                meta = parts.text("meta").required("meta").convertParam("meta") { partJson.decodeFromString<Meta>(it) },
                avatar = parts.file("avatar").required("avatar"),
                photos = parts.files("photos").takeIf { it.isNotEmpty() },
            )
        }
        service.upload(body)
        call.respond(HttpStatusCode.NoContent)
    }
    put("/uploads/file") {
        val file = call.receiveFile(52428800L)
        service.file(file)
        call.respond(HttpStatusCode.NoContent)
    }
}
`);
    const support = outputs[`${DIR}/ServerSupport.kt`];
    expect(support).toContain("import com.acme.models.HttpFile\n");
    expect(support).toContain(
      "internal suspend fun ApplicationCall.receiveParts(\n    limit: Long,\n    textParts: Set<String>,\n    fileParts: Set<String> = emptySet(),\n    multiParts: Set<String> = emptySet(),\n): ReceivedParts {",
    );
    expect(support).toContain(`throw BadRequestException("Part '$name' must be sent at most once")`);
    expect(support).toContain("if (size > limit) throw PayloadTooLargeException(limit)");
    expect(support).toContain("internal suspend fun ApplicationCall.receiveFile(limit: Long): HttpFile {");
    expect(support).toContain("is PartData.FormItem -> throw BadRequestException(\"File part '$name' must be sent with a filename\")");
    expect(support).toContain("internal val partJson: Json = Json\n");
    expect(support).not.toContain("partChannel");
  });

  it("streams multipart parts as a Flow of a sealed part class and file bodies as a channel", async () => {
    const { outputs } = await server({ multipart: "streaming" }).compile(uploadSpec);
    expect(outputs[`${DIR}/UploadsService.kt`]).toBe(`${HEADER}
package com.acme.server

import io.ktor.utils.io.ByteReadChannel
import kotlinx.coroutines.flow.Flow

interface UploadsService {
    suspend fun upload(parts: Flow<UploadPart>)
    suspend fun file(contentType: String?, channel: ByteReadChannel)
}
`);
    expect(outputs[`${DIR}/UploadPart.kt`]).toBe(`${HEADER}
package com.acme.server

import io.ktor.utils.io.ByteReadChannel

/**
 * One part of an \`Upload\` multipart request. The service's \`Flow\` reads the request while it is collected: collect
 * it once (a second collection throws IllegalStateException); a file part's \`channel\` is readable only until the
 * collector returns for that part.
 */
sealed class UploadPart {
    data class Name(val value: String) : UploadPart()
    data class Count(val value: Int) : UploadPart()
    data class Meta(val value: com.acme.models.Meta) : UploadPart()
    class Avatar(val filename: String?, val contentType: String?, val channel: ByteReadChannel) : UploadPart()
    class Photos(val filename: String?, val contentType: String?, val channel: ByteReadChannel) : UploadPart()
}
`);
    expect(outputs[`${DIR}/UploadsRoutes.kt`]).toBe(`${HEADER}
package com.acme.server

import com.acme.models.Meta
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.request.receiveChannel
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import io.ktor.server.routing.put

fun Route.uploadsRoutes(service: UploadsService) {
    post("/uploads") {
        val parts = call.partsFlow<UploadPart>(52428800L) { part ->
            when (part.name) {
                "name" -> emit(UploadPart.Name(part.partText()))
                "count" -> emit(UploadPart.Count(part.partText().convertParam("count") { it.toInt() }))
                "meta" -> emit(UploadPart.Meta(part.partText().convertParam("meta") { partJson.decodeFromString<Meta>(it) }))
                "avatar" -> emit(UploadPart.Avatar(part.partFileName(), part.contentType?.toString(), part.partChannel()))
                "photos" -> emit(UploadPart.Photos(part.partFileName(), part.contentType?.toString(), part.partChannel()))
            }
        }
        service.upload(parts)
        call.respond(HttpStatusCode.NoContent)
    }
    put("/uploads/file") {
        val contentType = call.request.headers[HttpHeaders.ContentType]
        val channel = call.receiveChannel()
        service.file(contentType, channel)
        call.respond(HttpStatusCode.NoContent)
    }
}
`);
    const support = outputs[`${DIR}/ServerSupport.kt`];
    expect(support).toContain("internal fun PartData.partChannel(): ByteReadChannel =");
    expect(support).toContain("internal fun <T> ApplicationCall.partsFlow(limit: Long, emitPart: suspend FlowCollector<T>.(PartData) -> Unit): Flow<T> {");
    expect(support).not.toContain("receiveParts");
    expect(support).not.toContain("receiveFile");
  });

  it("hands raw bodies to the service", async () => {
    const { outputs } = await server({ multipart: "raw" }).compile(uploadSpec);
    expect(outputs[`${DIR}/UploadsService.kt`]).toBe(`${HEADER}
package com.acme.server

import io.ktor.http.content.MultiPartData
import io.ktor.utils.io.ByteReadChannel

interface UploadsService {
    suspend fun upload(data: MultiPartData)
    suspend fun file(channel: ByteReadChannel)
}
`);
    expect(outputs[`${DIR}/UploadsRoutes.kt`]).toContain(`    post("/uploads") {
        call.withMultipart(52428800L) { data -> service.upload(data) }
        call.respond(HttpStatusCode.NoContent)
    }
    put("/uploads/file") {
        val channel = call.receiveChannel()
        service.file(channel)
        call.respond(HttpStatusCode.NoContent)
    }`);
    const support = outputs[`${DIR}/ServerSupport.kt`];
    expect(support).not.toContain("PartData.");
    expect(support).not.toContain("withUploadLimit");
    expect(support).toContain("internal suspend fun <T> ApplicationCall.withMultipart(limit: Long, block: suspend (MultiPartData) -> T): T {");
    // Only the parser's own limit failure answers 413, matched on Ktor's wording.
    expect(support).toContain('message.startsWith("Multipart content length exceeds limit ")');
    expect(support).not.toContain('contains("limit", ignoreCase = true)');
  });

  it("emits no upload helpers for JSON-only APIs", async () => {
    const { outputs } = await server().compile(petSpec);
    const support = outputs[`${DIR}/ServerSupport.kt`];
    expect(support).not.toContain("PartData");
    expect(support).not.toContain("HttpFile");
  });

  it("overrides the mode per operation and per group with @meta", async () => {
    const { outputs } = await server().compile(`using TspGen;\n${uploadSpec}
      @@meta(S.Uploads.upload, "kotlin:ktor-server", #{ multipart: "raw" });
    `);
    expect(outputs[`${DIR}/UploadsService.kt`]).toContain(`    suspend fun upload(data: MultiPartData)
    suspend fun file(file: HttpFile)`);
    const group = await server({ multipart: "raw" }).compile(`using TspGen;\n${uploadSpec}
      @@meta(S.Uploads, "kotlin:ktor-server", #{ multipart: "streaming" });
    `);
    expect(group.outputs[`${DIR}/UploadsService.kt`]).toContain(`    suspend fun upload(parts: Flow<UploadPart>)
    suspend fun file(contentType: String?, channel: ByteReadChannel)`);
  });

  it("reports an invalid multipart meta value and falls back to the option", async () => {
    const [result, diagnostics] = await server().compileAndDiagnose(`using TspGen;\n${uploadSpec}
      @@meta(S.Uploads.upload, "kotlin:ktor-server", #{ multipart: "chunked" });
    `);
    expectDiagnostics(diagnostics, {
      code: "@abhigyakrishna/tspgen-core/invalid-meta",
      message: /'multipart' on 'S\.Uploads\.upload' must be "buffered", "streaming" or "raw"/,
    });
    expect(result.outputs[`${DIR}/UploadsService.kt`]).toContain("    suspend fun upload(body: Upload)\n");
  });

  it("reads upload bodies in Resources routes too", async () => {
    const { outputs } = await server({ "routing-style": "resources" }).compile(uploadSpec);
    expect(outputs[`${DIR}/UploadsRoutes.kt`]).toContain(`    put<UploadsResources.FileResource> { resource ->
        val file = call.receiveFile(52428800L)
        service.file(file)
        call.respond(HttpStatusCode.NoContent)
    }`);
  });

  it("uses request objects with the upload fields", async () => {
    const { outputs } = await server({ "handler-shape": "request-object", multipart: "streaming" }).compile(uploadSpec);
    expect(outputs[`${DIR}/UploadsService.kt`]).toContain(`    data class FileRequest(
        val contentType: String?,
        val channel: ByteReadChannel,
    )`);
  });

  const textOnly = `
    @service namespace S;
    model Meta { title: string }
    model Form { name: HttpPart<string>; meta?: HttpPart<Meta>; }
    @route("/forms") interface Forms {
      @post send(@header contentType: "multipart/form-data", @multipartBody body: Form): void;
    }
  `;

  for (const mode of ["buffered", "streaming", "raw"] as const) {
    it(`keeps HttpFile out of text-only multipart (${mode})`, async () => {
      const { outputs } = await server({ multipart: mode }).compile(textOnly);
      expect(Object.keys(outputs).some((p) => p.endsWith("/HttpFile.kt"))).toBe(false);
      for (const [path, text] of Object.entries(outputs)) {
        if (path.startsWith("server/")) expect(text, path).not.toContain("HttpFile");
      }
    });
  }

  it("reads text-only multipart bodies without file parts", async () => {
    const { outputs } = await server().compile(textOnly);
    expect(outputs[`${DIR}/FormsRoutes.kt`]).toContain(
      `        val body = call.receiveParts(52428800L, setOf("name", "meta")).let { parts ->`,
    );
    expect(outputs[`${DIR}/ServerSupport.kt`]).toContain(
      "internal suspend fun ApplicationCall.receiveParts(\n    limit: Long,\n    textParts: Set<String>,\n    multiParts: Set<String> = emptySet(),\n): ReceivedParts {",
    );
  });

  it("declares each streaming part class once per model, qualifying distinct models with the same name", async () => {
    const { outputs } = await server({ multipart: "streaming" }, {
      packages: [{ namespace: "S.Other", package: "com.acme.other" }],
    }).compile(`
      @service namespace S;
      model Form { name: HttpPart<string>; }
      namespace Other { model Form { n: HttpPart<int32>; } }
      @route("/a") interface A {
        @post send(@header contentType: "multipart/form-data", @multipartBody body: Form): void;
      }
      @route("/b") interface B {
        @post send(@header contentType: "multipart/form-data", @multipartBody body: Form): void;
        @post @route("other") other(@header contentType: "multipart/form-data", @multipartBody body: Other.Form): void;
      }
    `);
    expect(outputs[`${DIR}/FormPart.kt`]).toContain("sealed class FormPart {\n    data class Name(val value: String) : FormPart()\n}");
    expect(outputs[`${DIR}/OtherFormPart.kt`]).toContain("sealed class OtherFormPart {\n    data class N(val value: Int) : OtherFormPart()\n}");
    expect(outputs[`${DIR}/AService.kt`]).not.toContain("sealed class");
    expect(outputs[`${DIR}/BService.kt`]).toContain("    suspend fun other(parts: Flow<OtherFormPart>)");
  });

  it("imports part classes and upload helpers into services in other packages", async () => {
    const { outputs } = await server({ multipart: "streaming", grouping: "per-namespace" }, {
      packages: [{ namespace: "S.Sub", package: "com.acme.sub" }],
    }).compile(`
      @service namespace S;
      model Form { name: HttpPart<string>; }
      namespace Sub {
        @route("/a") interface A {
          @post send(@header contentType: "multipart/form-data", @multipartBody body: Form): void;
        }
      }
    `);
    const [service] = Object.entries(outputs).filter(([p]) => p.endsWith("Service.kt") && p.includes("/sub/"));
    expect(service?.[1]).toContain("import com.acme.server.FormPart\n");
  });

  it("limits upload sizes from the option and per operation", async () => {
    const { outputs } = await server({ "max-upload-size": 1024 }).compile(`using TspGen;\n${uploadSpec}
      @@meta(S.Uploads.file, "kotlin:ktor-server", #{ maxUploadSize: 10 });
    `);
    const routes = outputs[`${DIR}/UploadsRoutes.kt`];
    expect(routes).toContain("call.receiveParts(1024L, ");
    expect(routes).toContain("val file = call.receiveFile(10L)");
  });

  it("reports an invalid maxUploadSize meta value and falls back to the option", async () => {
    const [result, diagnostics] = await server().compileAndDiagnose(`using TspGen;\n${uploadSpec}
      @@meta(S.Uploads.file, "kotlin:ktor-server", #{ maxUploadSize: -1 });
    `);
    expectDiagnostics(diagnostics, {
      code: "@abhigyakrishna/tspgen-core/invalid-meta",
      message: /'maxUploadSize' on 'S\.Uploads\.file' must be a positive integer/,
    });
    expect(result.outputs[`${DIR}/UploadsRoutes.kt`]).toContain("val file = call.receiveFile(52428800L)");
  });

  it("reads a part declared with an envelope as its body type", async () => {
    const { outputs } = await server().compile(`
      @service namespace S;
      model Meta { title: string }
      model Form { meta: HttpPart<{ @header contentType: "application/vnd.x+json"; @body body: Meta }>; }
      @post op send(@header contentType: "multipart/form-data", @multipartBody body: Form): void;
    `);
    expect(outputs["models/com/acme/models/Form.kt"]).toContain("val meta: Meta,");
    expect(outputs[`${DIR}/SRoutes.kt`]).toContain(
      'meta = parts.text("meta").required("meta").convertParam("meta") { partJson.decodeFromString<Meta>(it) },',
    );
  });

  it("decodes JSON parts with the java.time serializers", async () => {
    const { outputs } = await server().compile(`
      @service namespace S;
      model Form { times: HttpPart<utcDateTime[]>; }
      @post op send(@header contentType: "multipart/form-data", @multipartBody body: Form): void;
    `);
    const support = outputs[`${DIR}/ServerSupport.kt`];
    expect(support).toContain("import com.acme.models.modelSerializersModule\n");
    expect(support).toContain("internal val partJson: Json = Json { serializersModule = modelSerializersModule }\n");
    expect(outputs[`${DIR}/SRoutes.kt`]).toContain(
      'times = parts.text("times").required("times").convertParam("times") { partJson.decodeFromString<List<Instant>>(it) },',
    );
  });

  it("writes kotlinx's Flow qualified in the streaming path where a model is named Flow", async () => {
    const { outputs } = await server({ multipart: "streaming" }).compile(`
      @service namespace S;
      model Flow { rate: int32 }
      model Upload { name: HttpPart<string>; flow: HttpPart<Flow> }
      @route("/u") interface Uploads {
        @post upload(@header contentType: "multipart/form-data", @multipartBody body: Upload): void;
        @get flow(): Flow;
      }
    `);
    const service = outputs[`${DIR}/UploadsService.kt`];
    expect(service).toContain("    suspend fun upload(parts: kotlinx.coroutines.flow.Flow<UploadPart>)\n");
    expect(service).toContain("    suspend fun flow(): Flow\n");
    expect(service).toContain("import com.acme.models.Flow\n");
    expect(service).not.toContain("import kotlinx.coroutines.flow.Flow\n");
    const support = outputs[`${DIR}/ServerSupport.kt`];
    expect(support).toContain("-> Unit): kotlinx.coroutines.flow.Flow<T> {");
    expect(support).not.toContain("import kotlinx.coroutines.flow.Flow\n");
    expect(support).toContain("import kotlinx.coroutines.flow.FlowCollector\n");
  });
});
