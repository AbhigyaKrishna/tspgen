import { expectDiagnostics } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { client } from "./tester.js";

const DIR = "client/com/acme/client";
const socket = '@TspGen.meta("kotlin:ktor-client", #{ webSocket: true })';

describe("Ktor client WebSockets", () => {
  it("generates scoped sessions with normal path, query, header and auth handling", async () => {
    const { outputs } = await client().compile(`
      @service @useAuth(BearerAuth) namespace S;
      @route("/rooms") interface Rooms {
        ${socket} @get @route("/{room}/socket")
        connect(@path room: string, @query("target[type]") target: string, @header("x-trace") trace?: string, @cookie sid?: string): void;
      }
    `);
    const code = outputs[`${DIR}/RoomsClient.kt`];
    expect(code).toContain(
      "suspend fun connect(room: String, target: String, trace: String? = null, sid: String? = null, consume: suspend (io.ktor.client.plugins.websocket.DefaultClientWebSocketSession) -> Unit)",
    );
    expect(code).toContain("resolveAuth(this@RoomsClient.authPlan1)");
    expect(code).toContain('executeApiWebSocket(this@RoomsClient.http, this@RoomsClient.baseUrl, listOf("rooms", room, "socket"), {');
    expect(code).toContain('encodedParameters.append("target[type]", target.encodeURLParameter())');
    expect(code).toContain('trace?.let { header("x-trace", it) }');
    expect(code).toContain('sid?.let { cookie("sid", it) }');
    expect(code).toContain("applyAuth(credentials)");
    expect(code).toContain("}, consume)");
    expect(code).not.toContain("executeApiRequest");
    const support = outputs[`${DIR}/ClientSupport.kt`];
    expect(support).toContain("http.webSocket(request = {");
    expect(support).toContain("URLProtocol.HTTP -> URLProtocol.WS");
    expect(support).toContain("URLProtocol.HTTPS -> URLProtocol.WSS");
    expect(support).toContain("URLProtocol.WS, URLProtocol.WSS -> protocol");
    expect(support).toContain("configure(this)");
    expect(support).toContain("}) { consume(this) }");
    expect(outputs[`${DIR}/SApiClient.kt`]).toContain(`    install(WebSockets) {
        contentConverter = KotlinxWebsocketSerializationConverter(format)
    }`);
  });

  it("inherits metadata, permits HTTP overrides and avoids callback parameter collisions", async () => {
    const { outputs } = await client().compile(`
      @service namespace S;
      ${socket} interface Connections {
        @get @route("/socket") connect(@query consume: string, @query consumeSocket: string, @query http: string, @query baseUrl: string): void;
        @TspGen.meta("kotlin:ktor-client", #{ webSocket: false })
        @get @route("/plain") plain(): string;
      }
    `);
    const code = outputs[`${DIR}/ConnectionsClient.kt`];
    expect(code).toContain("consumeSocketSocket: suspend (io.ktor.client.plugins.websocket.DefaultClientWebSocketSession) -> Unit");
    expect(code).toContain("}, consumeSocketSocket)");
    expect(code).toContain("executeApiWebSocket(this@ConnectionsClient.http, this@ConnectionsClient.baseUrl,");
    expect(code).toContain("suspend fun plain(): String");
    expect(code).toContain("return executeApiRequest(");
  });

  it("adds no WebSocket dependency to HTTP-only clients", async () => {
    const { outputs } = await client().compile("@service namespace S; @get op value(): string;");
    expect(Object.values(outputs).join("\n")).not.toContain("WebSocket");
    expect(Object.values(outputs).join("\n")).not.toContain("webSocket");
  });

  it.each([
    ['@TspGen.meta("kotlin:ktor-client", #{ webSocket: "yes" }) @get op connect(): void;', "must be a boolean"],
    [`${socket} @post op connect(): void;`, "must be a GET operation"],
    [`${socket} @get op connect(@body body: string): void;`, "must be a GET operation"],
    [`${socket} @get op connect(): string;`, "must be a GET operation"],
    [`${socket} @get op connect(): { @header token: string };`, "must be a GET operation"],
  ])("rejects invalid WebSocket metadata without writing output: %s", async (operation, message) => {
    const [{ outputs }, diagnostics] = await client().compileAndDiagnose(`@service namespace S; ${operation}`);
    expectDiagnostics(diagnostics, {
      code: "@abhigyakrishna/tspgen-core/target-failed",
      severity: "error",
      message: new RegExp(message),
    });
    expect(Object.keys(outputs)).toHaveLength(0);
  });
});
