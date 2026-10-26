import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SseTester, TARGET } from "./tester.js";

const spec = `
  @service namespace S;
  model Pet { name: string; }
  @get @route("/lines") op lines(): TypeSpec.Http.Streams.JsonlStream<Pet>;
  @post @route("/ingest") op ingest(...TypeSpec.Http.Streams.JsonlStream<Pet>): int32;
`;

describe("Kotlin JSON-lines contracts", () => {
  it("generates cold response flows and streaming request bodies on both sides", async () => {
    const { outputs } = await SseTester.import("@typespec/http/streams").emit("@abhigyakrishna/tspgen-kotlin", {
      package: "com.acme",
      targets: [TARGET, resolve(import.meta.dirname, "../../kotlin-ktor-client/dist/index.js")],
    }).compile(spec);
    const service = outputs["server/com/acme/server/SService.kt"];
    expect(service).toContain("suspend fun lines(): Flow<Pet>");
    expect(service).toContain("body: Flow<Pet>");
    const client = outputs["client/com/acme/client/SClient.kt"];
    expect(client).toContain("fun lines(): Flow<Pet> = flow");
    expect(client).toContain("readJsonLines");
    expect(client).toContain("JsonLinesContent(body, Pet.serializer()");
    expect(client).not.toContain("readSse");
    expect(outputs["server/com/acme/server/SRoutes.kt"]).toContain("call.respondJsonLines");
    expect(outputs["server/com/acme/server/SRoutes.kt"]).toContain("call.receiveJsonLines(Pet.serializer())");
  });
});
