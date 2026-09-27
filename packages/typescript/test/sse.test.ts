import { buildApiIR, loadSseLibraries } from "@abhigyakrishna/tspgen-core";
import { expectDiagnostics } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { transformToTs } from "../src/transform/index.js";
import { emitter, HEADER, SseTester } from "./tester.js";

const spec = `
  @service namespace S;
  model UserConnect { username: string }
  /** Channel events */
  @events union ChannelEvents {
    userConnect: UserConnect,
    @Events.contentType("text/plain") note: string,
    @Events.contentType("text/plain") count: int32,
    @Events.contentType("text/plain") flag: boolean,
    @Events.contentType("application/json") quoted: string,
    @Events.contentType("text/plain") @terminalEvent "[done]",
  }
  @route("/c") op subscribe(): SSEStream<ChannelEvents>;
`;

const SSE = await loadSseLibraries();

function tsIR(program: Parameters<typeof buildApiIR>[0]) {
  return transformToTs(program, buildApiIR(program, { sse: SSE! }), { zod: true, importExtension: "" });
}

describe("typescript server-sent events", () => {
  it("emits an @events union as { event, data } variants with a discriminated zod union", async () => {
    const { outputs } = await SseTester.emit("@abhigyakrishna/tspgen-typescript", { features: { zod: true } }).compile(spec);
    expect(outputs["models/ChannelEvents.ts"]).toBe(`${HEADER}
import { z } from "zod";
import { UserConnectSchema } from "./UserConnect";
import type { UserConnect } from "./UserConnect";

/**
 * Channel events
 */
export type ChannelEvents =
  | { event: "userConnect"; data: UserConnect }
  | { event: "note"; data: string }
  | { event: "count"; data: number }
  | { event: "flag"; data: boolean }
  | { event: "quoted"; data: string }
  | { event: "message"; data: "[done]" };

export const ChannelEventsSchema: z.ZodType<ChannelEvents> = z.discriminatedUnion("event", [z.object({ event: z.literal("userConnect"), data: z.lazy(() => UserConnectSchema) }), z.object({ event: z.literal("note"), data: z.string() }), z.object({ event: z.literal("count"), data: z.number().int() }), z.object({ event: z.literal("flag"), data: z.boolean() }), z.object({ event: z.literal("quoted"), data: z.string() }), z.object({ event: z.literal("message"), data: z.literal("[done]") })]);
`);
    expect(outputs["models/SseMessage.ts"]).toBeUndefined();
  });

  it("describes how the client decodes each event", async () => {
    const { program } = await SseTester.compile(spec);
    const [op] = tsIR(program).services[0].groups[0].operations;
    expect(op.result).toMatchObject({ kind: "single", type: { text: "AsyncIterable<ChannelEvents>" }, status: 200, contentType: "text/event-stream" });
    expect(op.result.kind === "single" && op.result.stream?.events).toEqual([
      { event: "userConnect", data: "json", terminal: false },
      { event: "note", data: "text", terminal: false },
      { event: "count", data: "number", terminal: false },
      { event: "flag", data: "boolean", terminal: false },
      { event: "quoted", data: "json", terminal: false },
      { event: "message", data: "text", literal: "[done]", value: "[done]", terminal: true },
    ]);
  });

  it("uses a plain zod union when event names repeat", async () => {
    const { outputs } = await SseTester.emit("@abhigyakrishna/tspgen-typescript", { features: { zod: true }, layout: "single-file" }).compile(`
      @service namespace S;
      @events union Ticks { int32, @Events.contentType("text/plain") @terminalEvent "[DONE]" }
      @route("/t") op ticks(): SSEStream<Ticks>;
    `);
    const types = outputs["types.ts"];
    expect(types).toContain(`export type Ticks =
  | { event: "message"; data: number }
  | { event: "message"; data: "[DONE]" };`);
    expect(types).toContain(
      `export const TicksSchema: z.ZodType<Ticks> = z.union([z.object({ event: z.literal("message"), data: z.number().int() }), z.object({ event: z.literal("message"), data: z.literal("[DONE]") })]);`,
    );
    const schema = new Function("z", `return ${/= (z\.union\(.*\));/.exec(types)![1]}`)(z) as z.ZodType;
    expect(schema.parse({ event: "message", data: 3 })).toEqual({ event: "message", data: 3 });
  });

  it("emits SseMessage for untyped streams", async () => {
    const { outputs } = await emitter({ features: { zod: true } }).compile(`
      @service namespace S;
      @route("/a") op a(): { @header contentType: "text/event-stream"; @body body: string };
    `);
    expect(outputs["models/SseMessage.ts"]).toBe(`${HEADER}
import { z } from "zod";

/**
 * One server-sent event of an untyped event stream.
 */
export interface SseMessage {
  /**
   * The \`event:\` name; absent for the default "message" type.
   */
  event?: string;
  /**
   * The \`data:\` lines, joined with "\\n".
   */
  data: string;
  /**
   * The last \`id:\`.
   */
  id?: string;
}

export const SseMessageSchema: z.ZodType<SseMessage> = z.object({
  event: z.string().exactOptional(),
  data: z.string(),
  id: z.string().exactOptional(),
});
`);
    expect(outputs["models/index.ts"]).toContain('export * from "./SseMessage";');
  });

  it("reports a type generated as SseMessage when untyped streams need it", async () => {
    const [, diagnostics] = await emitter().compileAndDiagnose(`
      @service namespace S;
      model SseMessage { text: string }
      @route("/m") op m(): SseMessage;
      @route("/a") op a(): { @header contentType: "text/event-stream"; @body body: string };
    `);
    expectDiagnostics(diagnostics, {
      code: "@abhigyakrishna/tspgen-typescript/sse-message-conflict",
      message: /Type 'S.SseMessage' is generated as SseMessage/,
    });
  });
});
