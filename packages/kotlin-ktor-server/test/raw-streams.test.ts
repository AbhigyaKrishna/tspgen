import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SseTester, TARGET } from "./tester.js";

const client = resolve(import.meta.dirname, "../../kotlin-ktor-client/dist/index.js");
const spec = `
  @service namespace S;
  model Item { value: string; }
  @get @route("/binary") op binary(): TypeSpec.Http.Streams.HttpStream<Item, "application/x-custom", bytes>;
  @get @route("/text") op text(): TypeSpec.Http.Streams.HttpStream<string, "text/plain">;
  @post @route("/upload") op upload(...TypeSpec.Http.Streams.HttpStream<bytes, "application/octet-stream", bytes>): int32;
  @post @route("/text-upload") op textUpload(...TypeSpec.Http.Streams.HttpStream<string, "text/plain">): int32;
  @get @route("/metadata") op withHeaders(): {
    @statusCode status: 206; @header trace: string;
    ...TypeSpec.Http.Streams.HttpStream<bytes, "application/octet-stream", bytes>;
  } | { @statusCode status: 204; };
`;

function emitter(enabled = true) {
  return SseTester.import("@typespec/http/streams").emit("@abhigyakrishna/tspgen-kotlin", {
    package: "com.acme", features: { "raw-streams": enabled }, targets: [TARGET, client],
  });
}

describe("Kotlin raw HTTP streams", () => {
  it("exposes wire chunks and streams request/response bodies without SSE framing", async () => {
    const { outputs } = await emitter().compile(spec);
    const service = outputs["server/com/acme/server/SService.kt"];
    expect(service).toContain("suspend fun binary(): Flow<ByteArray>");
    expect(service).toContain("suspend fun text(): Flow<String>");
    expect(service).toContain("upload(body: Flow<ByteArray>)");
    expect(service).toContain("textUpload(body: Flow<String>)");
    const generatedClient = outputs["client/com/acme/client/SClient.kt"];
    expect(generatedClient).toContain("fun binary(): Flow<ByteArray> = flow");
    expect(generatedClient).toContain("readRawBytes");
    expect(generatedClient).toContain("response.readRawText");
    expect(generatedClient).toContain('RawBytesContent(body, "application/octet-stream")');
    expect(generatedClient).toContain('RawTextContent(body, "text/plain")');
    expect(generatedClient).toContain("consume: suspend (WithHeadersResult) -> Unit");
    const routes = outputs["server/com/acme/server/SRoutes.kt"];
    expect(routes).toContain('call.respondRawBytes(HttpStatusCode.OK, "application/x-custom"');
    expect(routes).toContain('call.receiveRawText("text/plain")');
    expect(routes).toContain("call.respondRawBytes(HttpStatusCode.PartialContent");
    const support = outputs["server/com/acme/server/ServerSupport.kt"];
    expect(support).toContain("input.compact()");
    expect(support).toContain("RawStreamDecodingException");
    expect(support).not.toContain("sseFrame");
    expect(outputs["client/com/acme/client/ClientSupport.kt"]).not.toContain("readSse");
  });

  it("retains buffered APIs when the feature is disabled", async () => {
    const { outputs } = await emitter(false).compile(spec);
    expect(outputs["client/com/acme/client/SClient.kt"]).toContain("suspend fun binary(): ByteArray");
    expect(outputs["client/com/acme/client/ClientSupport.kt"]).not.toContain("RawStreamContent");
    expect(outputs["server/com/acme/server/ServerSupport.kt"]).not.toContain("readRawBytes");
  });

  it("rejects declared SSE request streams instead of silently buffering them", async () => {
    const [, diagnostics] = await emitter().compileAndDiagnose(`
      @service namespace S;
      @events union Updates { value: string }
      @post op upload(...SSEStream<Updates>): void;
    `);
    expect(diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
      code: "@abhigyakrishna/tspgen-core/unsupported-request-stream", severity: "error",
    })]));
  });

  it("rejects optional raw bodies whose absence is indistinguishable from an empty stream", async () => {
    const [, diagnostics] = await emitter().compileAndDiagnose(`
      @service namespace S;
      @TypeSpec.Streams.streamOf(string)
      model Input { @header contentType: "text/plain"; @body body?: string; }
      @post op upload(...Input): void;
    `);
    expect(diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
      code: "@abhigyakrishna/tspgen-core/optional-raw-stream", severity: "error",
    })]));
  });
});
