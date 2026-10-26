import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Tester, TARGET } from "./tester.js";
import { server } from "./tester.js";
import { expectDiagnostics } from "@typespec/compiler/testing";

describe("Kotlin tuple multipart contracts", () => {
  it("emits typed request models and preserves names and multipart media types", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-kotlin", {
      package: "com.acme", targets: [TARGET, resolve(import.meta.dirname, "../../kotlin-ktor-client/dist/index.js")],
    }).compile(`
      @service namespace S;
      model Meta { name: string; }
      @route("/parts") interface Parts {
        @post upload(@header contentType: "multipart/form-data", @multipartBody body: [HttpPart<string, #{ name: "caption" }>, HttpPart<File, #{ name: "image" } >]): void;
        @post @route("/mixed") mixed(@header contentType: "multipart/mixed", @multipartBody body: [HttpPart<Meta>, HttpPart<File>]): void;
      }
    `);
    const request = outputs["models/com/acme/models/SPartsUploadMultipart.kt"];
    expect(request).toContain("val item1: String");
    expect(request).toContain("val item2: HttpFile");
    expect(request).not.toContain("@Serializable");
    const routes = outputs["server/com/acme/server/PartsRoutes.kt"];
    expect(routes).toContain('positionalNames = listOf("caption", "image")');
    expect(routes).toContain('positionalNames = listOf("part1", "part2")');
    const client = outputs["client/com/acme/client/PartsClient.kt"];
    expect(client).toContain('append("caption", body.item1)');
    expect(client).toContain('"multipart/mixed"');
    expect(client).toContain("multipartContent(");
  });

  it("rejects ambiguous repeated unnamed parts rather than misassigning following values", async () => {
    const [, diagnostics] = await server().compileAndDiagnose(`
      @service namespace S;
      @post op upload(@header contentType: "multipart/mixed", @multipartBody body: [HttpPart<string>[], HttpPart<string>]): void;
    `);
    expectDiagnostics(diagnostics, { code: "@abhigyakrishna/tspgen-core/ambiguous-multipart-parts", severity: "error" });
  });

  it("keeps the positional cursor on a trailing repeated part in streaming mode", async () => {
    const { outputs } = await server({ multipart: "streaming" }).compile(`
      @service namespace S;
      @post op upload(@header contentType: "multipart/mixed", @multipartBody body: [HttpPart<string>, HttpPart<string>[]]): void;
    `);
    const routes = outputs["server/com/acme/server/SRoutes.kt"];
    expect(routes).toContain('else if (partName !in setOf<String>("part2")) partPosition++');
    expect(routes).toContain(".validateParts(");
  });
});
