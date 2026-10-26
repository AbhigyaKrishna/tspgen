import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Tester, TARGET } from "./tester.js";

describe("Kotlin multipart responses", () => {
  it("emits typed model and tuple response readers and MIME writers", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-kotlin", {
      package: "com.acme", targets: [TARGET, resolve(import.meta.dirname, "../../kotlin-ktor-client/dist/index.js")],
    }).compile(`
      @service namespace S;
      model Pet { name: string; }
      model Bundle { caption: HttpPart<string>; pet: HttpPart<Pet>; photo: HttpPart<File>; extra?: HttpPart<string>; }
      interface Downloads {
        @get @route("/form") form(): { @header contentType: "multipart/form-data"; @multipartBody body: Bundle; };
        @get @route("/mixed") mixed(): { @header contentType: "multipart/mixed"; @multipartBody body: [HttpPart<Pet>, HttpPart<File>]; };
      }
    `);
    const routes = outputs["server/com/acme/server/DownloadsRoutes.kt"];
    expect(routes).toContain('call.respondMultipart(HttpStatusCode.OK, "multipart/form-data"');
    expect(routes).toContain('call.respondMultipart(HttpStatusCode.OK, "multipart/mixed"');
    expect(routes).toContain("service.form().let { multipart ->");
    const client = outputs["client/com/acme/client/DownloadsClient.kt"];
    expect(client).toContain("http.readMultipart(response");
    expect(client).toContain('parts["caption"].orEmpty().single()');
    expect(client).toContain("http.apiJson.decodeFromString(Pet.serializer()");
    expect(outputs["client/com/acme/client/ClientSupport.kt"]).toContain("part.release()");
  });
});
