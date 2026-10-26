import { describe, expect, it } from "vitest";
import { server } from "./tester.js";
import { expectDiagnostics } from "@typespec/compiler/testing";

describe("Ktor server WebSocket contracts", () => {
  it.each(["dsl", "resources"])("generates scoped service sessions with %s routing", async (style) => {
    const { outputs } = await server({ "routing-style": style }).compile(`
      using TspGen;
      @service namespace S;
      @meta("kotlin", #{ webSocket: true })
      @route("/events") interface Events {
        @get open(@query room?: string): { @statusCode status: 101; };
      }
    `);
    const directory = "server/com/acme/server";
    expect(outputs[`${directory}/EventsService.kt`]).toContain("session: io.ktor.server.websocket.DefaultWebSocketServerSession");
    const routes = outputs[`${directory}/EventsRoutes.kt`];
    expect(routes).toContain('route("/events")');
    expect(routes).toContain("install(WebSocketHandshakeValidation)");
    expect(routes).toContain("webSocket {");
    expect(routes).toContain("val session = this");
    expect(routes).toContain("service.open(room, session)");
    expect(routes).not.toContain("call.respond(");
    expect(outputs[`${directory}/SModule.kt`]).toContain("install(WebSockets)");
    expect(outputs[`${directory}/SModule.kt`]).toContain("KotlinxWebsocketSerializationConverter(serverJson)");
  });

  it.each([
    ['@TspGen.meta("kotlin:ktor-server", #{ webSocket: "yes" }) @get op connect(): void;', "must be a boolean"],
    ['@TspGen.meta("kotlin:ktor-server", #{ webSocket: true }) @post op connect(): void;', "must be a GET operation"],
    ['@TspGen.meta("kotlin:ktor-server", #{ webSocket: true }) @get op connect(): string;', "must be a GET operation"],
  ])("rejects invalid handshake contracts without output", async (operation, message) => {
    const [{ outputs }, diagnostics] = await server().compileAndDiagnose(`@service namespace S; ${operation}`);
    expectDiagnostics(diagnostics, { code: "@abhigyakrishna/tspgen-core/target-failed", severity: "error", message: new RegExp(message) });
    expect(Object.keys(outputs)).toHaveLength(0);
  });
});
