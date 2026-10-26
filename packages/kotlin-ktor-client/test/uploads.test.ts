import { expectDiagnostics } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { client } from "./tester.js";

const DIR = "client/com/acme/client";

const uploadSpec = `
  @service namespace S;
  model Meta { title: string }
  enum Kind { a, b }
  model Upload {
    name: HttpPart<string>;
    count?: HttpPart<int32>;
    kind?: HttpPart<Kind>;
    meta: HttpPart<Meta>;
    tags?: HttpPart<int32>[];
    avatar: HttpPart<File>;
    photos: HttpPart<File<"image/png">>[];
  }
  @route("/uploads") interface Uploads {
    @post upload(@header contentType: "multipart/form-data", @multipartBody body: Upload): void;
    @put @route("/file") file(@bodyRoot file: File<"image/png">): void;
  }
`;

describe("ktor client uploads", () => {
  it("reads file downloads with metadata and enforces configured response limits", async () => {
    const { outputs } = await client({ "max-response-size": 1024 }).compile(`
      @service namespace S;
      @route("/files") interface Files { @get download(): File<"application/octet-stream">; }
    `);
    const files = outputs[`${DIR}/FilesClient.kt`];
    expect(files).toContain("HttpFile(");
    expect(files).toContain("response.headers[io.ktor.http.HttpHeaders.ContentDisposition]");
    expect(files).toContain("response.apiBodyBytes()");
  });
  it("reads file downloads as bytes with the response filename and content type", async () => {
    const [{ outputs }, diagnostics] = await client().compileAndDiagnose(`
      @service namespace S;
      @get op download(): File<"image/png">;
    `);
    expectDiagnostics(diagnostics, []);
    const code = outputs[`${DIR}/SClient.kt`];
    expect(code).toContain("suspend fun download(): HttpFile");
    expect(code).toContain("filename = response.headers[io.ktor.http.HttpHeaders.ContentDisposition]");
    expect(code).toContain("io.ktor.http.ContentDisposition.parse(it).parameter(io.ktor.http.ContentDisposition.Parameters.FileName)");
    expect(code).toContain("contentType = response.headers[io.ktor.http.HttpHeaders.ContentType]");
    expect(code).toContain("bytes = response.body<ByteArray>()");
  });

  it("uses the bounded byte reader for every file success and typed-error branch", async () => {
    const [{ outputs }, diagnostics] = await client({ "max-response-size": 8, "max-error-size": 4 }).compileAndDiagnose(`
      @service namespace S;
      @error model Gone { @statusCode status: 410; @body file: File<"application/octet-stream">; }
      @get op download(): File<"image/png"> | { @statusCode status: 201; @body file: File<"application/pdf"> } | Gone;
    `);
    expectDiagnostics(diagnostics, []);
    const code = outputs[`${DIR}/SClient.kt`];
    expect(code.match(/bytes = response\.apiBodyBytes\(\)/g)).toHaveLength(3);
    expect(code).not.toContain("bytes = response.body<ByteArray>()");
    expect(code).not.toContain("http.readApiBody<HttpFile>");
  });

  it("sends multipart bodies as MultiPartFormDataContent without an explicit content type", async () => {
    const { outputs } = await client().compile(uploadSpec);
    const uploads = outputs[`${DIR}/UploadsClient.kt`];
    expect(uploads).toContain(`    suspend fun upload(body: Upload) {
        return executeApiRequest(http, baseUrl, HttpMethod.Post, listOf("uploads"), {
            setBody(
                MultiPartFormDataContent(
                    formData {
                        append("name", body.name)
                        body.count?.let { append("count", it.toString()) }
                        body.kind?.let { append("kind", encodeParam(it)) }
                        append("meta", http.encodeJson(body.meta), jsonPartHeaders())
                        body.tags?.forEach { append("tags", it.toString()) }
                        append("avatar", body.avatar.bytes, fileHeaders(body.avatar, "avatar", "application/octet-stream"))
                        body.photos.forEach { append("photos", it.bytes, fileHeaders(it, "photos", "image/png")) }
                    },
                ),
            )
        }, { response ->`);
    expect(uploads).toContain("import io.ktor.client.request.forms.MultiPartFormDataContent\n");
    expect(uploads).toContain("import io.ktor.client.request.forms.formData\n");
  });

  it("sends file bodies as bytes with their content type and filename", async () => {
    const { outputs } = await client().compile(uploadSpec);
    expect(outputs[`${DIR}/UploadsClient.kt`]).toContain(`    suspend fun file(file: HttpFile) {
        return executeApiRequest(http, baseUrl, HttpMethod.Put, listOf("uploads", "file"), {
            contentType(ContentType.parse(file.contentType ?: "image/png"))
            file.filename?.let { header(HttpHeaders.ContentDisposition, ContentDisposition.Attachment.withParameter(ContentDisposition.Parameters.FileName, it).toString()) }
            setBody(file.bytes)
        }, { response ->`);
  });

  it("adds the multipart helpers to ClientSupport.kt only when needed", async () => {
    const { outputs } = await client().compile(uploadSpec);
    const support = outputs[`${DIR}/ClientSupport.kt`];
    expect(support).toContain("import com.acme.models.HttpFile\n");
    expect(support).toContain(`internal fun fileHeaders(file: HttpFile, part: String, defaultType: String): Headers =
    headersOf(
        HttpHeaders.ContentType to listOf(file.contentType ?: defaultType),
        HttpHeaders.ContentDisposition to listOf("\${ContentDisposition.Parameters.FileName}=\${(file.filename ?: part).quote()}"),
    )`);
    expect(support).toContain("import io.ktor.http.quote\n");
    expect(support).toContain("internal inline fun <reified T> HttpClient.encodeJson(value: T): String = apiJson.encodeToJsonElement(value).toString()");
    expect(support).toContain("get() = attributes.getOrNull(apiJsonKey) ?: SJson");
    const plain = await client().compile(`@service namespace S; model P { a: string } @post op make(@body p: P): void;`);
    expect(plain.outputs[`${DIR}/ClientSupport.kt`]).not.toContain("fileHeaders");
  });

  it("keeps file helpers out of text-only multipart APIs", async () => {
    const { outputs } = await client().compile(`
      @service namespace S;
      model Meta { title: string }
      model Form { name: HttpPart<string>; meta: HttpPart<Meta>; }
      @post op send(@header contentType: "multipart/form-data", @multipartBody body: Form): void;
    `);
    const support = outputs[`${DIR}/ClientSupport.kt`];
    expect(support).not.toContain("HttpFile");
    expect(support).not.toContain("fileHeaders");
    expect(support).toContain('internal fun jsonPartHeaders(contentType: String = "application/json"): Headers =');
    expect(outputs[`${DIR}/SClient.kt`]).not.toContain("HttpFile");
  });

  it("encodes JSON parts with the java.time serializers of <Service>Json", async () => {
    const { outputs } = await client().compile(`
      @service namespace S;
      model Form { times: HttpPart<utcDateTime[]>; }
      @post op send(@header contentType: "multipart/form-data", @multipartBody body: Form): void;
    `);
    expect(outputs[`${DIR}/SApiClient.kt`]).toContain("    serializersModule = modelSerializersModule\n");
    expect(outputs[`${DIR}/ClientSupport.kt`]).toContain("get() = attributes.getOrNull(apiJsonKey) ?: SJson");
    expect(outputs[`${DIR}/SClient.kt`]).toContain('append("times", http.encodeJson(body.times), jsonPartHeaders())');
  });

  it("sends JSON parts with their declared JSON content type", async () => {
    const { outputs } = await client().compile(`
      @service namespace S;
      model Meta { title: string }
      model Form {
        patch: HttpPart<{ @header contentType: "application/merge-patch+json"; @body value: Meta }>;
        multi: HttpPart<{ @header contentType: "text/plain" | "application/vnd.acme+json"; @body value: Meta }>;
        meta: HttpPart<Meta>;
      }
      @post op send(@header contentType: "multipart/form-data", @multipartBody body: Form): void;
    `);
    const send = outputs[`${DIR}/SClient.kt`];
    expect(send).toContain('append("patch", http.encodeJson(body.patch), jsonPartHeaders("application/merge-patch+json"))');
    expect(send).toContain('append("multi", http.encodeJson(body.multi), jsonPartHeaders("application/vnd.acme+json"))');
    expect(send).toContain('append("meta", http.encodeJson(body.meta), jsonPartHeaders())');
    // An envelope part carries its body's type, not a wrapper model.
    const form = outputs["models/com/acme/models/Form.kt"];
    expect(form).toContain("val patch: Meta,");
    expect(form).toContain("val multi: Meta,");
    expect(Object.keys(outputs).filter((p) => /FormPatch|FormMulti/.test(p))).toEqual([]);
  });
});
