import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SseTester, TARGET, server } from "./tester.js";

describe("Kotlin streaming response metadata", () => {
  it("retains headers and alternate success responses in a scoped client callback", async () => {
    const { outputs } = await SseTester.import("@typespec/http/streams").emit("@abhigyakrishna/tspgen-kotlin", {
      package: "com.acme", targets: [TARGET, resolve(import.meta.dirname, "../../kotlin-ktor-client/dist/index.js")],
    }).compile(`
      @service namespace S;
      model Pet { name: string; }
      @get @route("/watch") op watch(): { @statusCode status: 201; @header trace: string; ...TypeSpec.Http.Streams.JsonlStream<Pet>; } | { @statusCode status: 204; };
      @get @route("/events") op events(): { @header trace: string; @header contentType: "text/event-stream"; @body body: string; };
    `);
    const client = outputs["client/com/acme/client/SClient.kt"];
    expect(client).toContain("consume: suspend (WatchResult) -> Unit");
    expect(client).toContain("response.status.value == 201");
    expect(client).toContain("readJsonLines");
    expect(client).toContain("consumeActive = false");
    expect(client).toContain("consume: suspend (EventsResult) -> Unit");
    expect(outputs["models/com/acme/api/WatchResult.kt"]).toContain("val body: Flow<Pet>");
    const routes = outputs["server/com/acme/server/SRoutes.kt"];
    expect(routes).toContain("call.respondJsonLines(HttpStatusCode.Created");
    expect(routes).toContain("call.response.status(HttpStatusCode.OK)");
    expect(routes).toContain('call.response.header("trace", result.trace)');
  });

  it("dispatches streams sharing a status by content type", async () => {
    const { outputs } = await SseTester.import("@typespec/http/streams").emit("@abhigyakrishna/tspgen-kotlin", {
      package: "com.acme", targets: [TARGET, resolve(import.meta.dirname, "../../kotlin-ktor-client/dist/index.js")],
    }).compile(`
      @service namespace S;
      model Pet { name: string; }
      @get op watch(): TypeSpec.Http.Streams.JsonlStream<Pet> | {
        @header contentType: "text/event-stream"; @body body: string;
      };
    `);
    const client = outputs["client/com/acme/client/SClient.kt"];
    expect(client).toContain('equals("application/jsonl", ignoreCase = true)');
    expect(client).toContain('equals("text/event-stream", ignoreCase = true)');
    expect(client).toContain("readJsonLines");
    expect(client).toContain("readSse");
  });

  it("renders service, group, operation and parameter documentation in both targets", async () => {
    const spec = `
      @doc("Shop API.") @service #deprecated "Use Store."
      namespace Shop;
      @doc("Old pets.") #deprecated "Use Animals."
      @route("/pets") interface Pets {
        @doc("Find a pet.") @get get(@query @doc("Pet label.") #deprecated "Use id."
          name: string): string;
        @post save(@body @doc("Pet details.") #deprecated "Use record."
          details: string): string;
      }
    `;
    const targets = [TARGET, resolve(import.meta.dirname, "../../kotlin-ktor-client/dist/index.js")];
    const { outputs } = await server({}, { targets }).compile(spec);
    const service = outputs["server/com/acme/server/PetsService.kt"];
    const client = outputs["client/com/acme/client/PetsClient.kt"];
    for (const source of [service, client]) {
      expect(source).toContain("Old pets.");
      expect(source).toContain("Find a pet.");
      expect(source).toContain('@Deprecated("Use Animals.")');
      expect(source).toContain("@param name Pet label. Deprecated: Use id.");
      expect(source).toContain("@param details Pet details. Deprecated: Use record.");
    }
    expect(outputs["client/com/acme/client/ShopApiClient.kt"]).toContain("Shop API.");
    expect(outputs["client/com/acme/client/ShopApiClient.kt"]).toContain('@Deprecated("Use Store.")');
    const disabled = await server({}, { targets, features: { docs: false } }).compile(spec);
    expect(Object.values(disabled.outputs).join("\n")).not.toContain("Pet label.");
  });
});
