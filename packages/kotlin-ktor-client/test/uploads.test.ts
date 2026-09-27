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
  it("sends multipart bodies as MultiPartFormDataContent without an explicit content type", async () => {
    const { outputs } = await client().compile(uploadSpec);
    const uploads = outputs[`${DIR}/UploadsClient.kt`];
    expect(uploads).toContain(`    suspend fun upload(body: Upload) {
        val response = http.request {
            method = HttpMethod.Post
            url {
                takeFrom(baseUrl)
                appendPathSegments("uploads")
            }
            setBody(
                MultiPartFormDataContent(
                    formData {
                        append("name", body.name)
                        body.count?.let { append("count", it.toString()) }
                        body.kind?.let { append("kind", encodeParam(it)) }
                        append("meta", encodeJson(body.meta), jsonPartHeaders())
                        body.tags?.forEach { append("tags", it.toString()) }
                        append("avatar", body.avatar.bytes, fileHeaders(body.avatar, "avatar", "application/octet-stream"))
                        body.photos.forEach { append("photos", it.bytes, fileHeaders(it, "photos", "image/png")) }
                    },
                ),
            )
        }`);
    expect(uploads).toContain("import io.ktor.client.request.forms.MultiPartFormDataContent\n");
    expect(uploads).toContain("import io.ktor.client.request.forms.formData\n");
  });

  it("sends file bodies as bytes with their content type and filename", async () => {
    const { outputs } = await client().compile(uploadSpec);
    expect(outputs[`${DIR}/UploadsClient.kt`]).toContain(`    suspend fun file(file: HttpFile) {
        val response = http.request {
            method = HttpMethod.Put
            url {
                takeFrom(baseUrl)
                appendPathSegments("uploads", "file")
            }
            contentType(ContentType.parse(file.contentType ?: "image/png"))
            file.filename?.let { header(HttpHeaders.ContentDisposition, ContentDisposition.Attachment.withParameter(ContentDisposition.Parameters.FileName, it).toString()) }
            setBody(file.bytes)
        }`);
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
    expect(support).toContain("internal inline fun <reified T> encodeJson(value: T): String = partJson.encodeToJsonElement(value).toString()");
    expect(support).toContain("internal val partJson: Json = Json\n");
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

  it("encodes JSON parts with the java.time serializers", async () => {
    const { outputs } = await client().compile(`
      @service namespace S;
      model Form { times: HttpPart<utcDateTime[]>; }
      @post op send(@header contentType: "multipart/form-data", @multipartBody body: Form): void;
    `);
    const support = outputs[`${DIR}/ClientSupport.kt`];
    expect(support).toContain("import com.acme.models.javaTimeSerializersModule\n");
    expect(support).toContain("internal val partJson: Json = Json { serializersModule = javaTimeSerializersModule }\n");
    expect(outputs[`${DIR}/SClient.kt`]).toContain('append("times", encodeJson(body.times), jsonPartHeaders())');
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
    expect(send).toContain('append("patch", encodeJson(body.patch), jsonPartHeaders("application/merge-patch+json"))');
    expect(send).toContain('append("multi", encodeJson(body.multi), jsonPartHeaders("application/vnd.acme+json"))');
    expect(send).toContain('append("meta", encodeJson(body.meta), jsonPartHeaders())');
    // An envelope part carries its body's type, not a wrapper model.
    const form = outputs["models/com/acme/models/Form.kt"];
    expect(form).toContain("val patch: Meta,");
    expect(form).toContain("val multi: Meta,");
    expect(Object.keys(outputs).filter((p) => /FormPatch|FormMulti/.test(p))).toEqual([]);
  });
});
