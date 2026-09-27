import { resolvePath } from "@typespec/compiler";
import { createTester, expectDiagnostics } from "@typespec/compiler/testing";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApiIR, loadSseLibraries, usesSseLibraries, type ResponseIR, type UnionIR } from "../../src/index.js";
import { Tester } from "../tester.js";

const SseTester = createTester(resolvePath(import.meta.dirname, "../.."), {
  libraries: ["@typespec/http", "@typespec/streams", "@typespec/events", "@typespec/sse"],
})
  .importLibraries()
  .using("Http", "SSE", "Events");

const spec = `
  @service namespace S;
  model UserConnect { username: string; time: utcDateTime }
  scalar Note extends string;

  /** Channel events */
  @events union ChannelEvents {
    /** A user joined */
    userconnect: UserConnect,
    note: Note,
    count: int32,
    @Events.contentType("application/json") quoted: string,
    wrapped: { kind: "wrapped", @data @Events.contentType("text/plain") text: string },
    @terminalEvent "[done]",
  }

  @route("/c") op subscribe(@query room: string): SSEStream<ChannelEvents>;
  @route("/raw") op raw(): { @header contentType: "text/event-stream"; @body body: string };
`;

function successBody(responses: ResponseIR[]) {
  return responses.find((r) => !r.isError)?.body;
}

const sse = await loadSseLibraries();
const withSse = { ...(sse ? { sse } : {}) };

describe("server-sent events", () => {
  it("loads the optional SSE libraries on demand", async () => {
    expect(sse).toBeDefined();
    expect(usesSseLibraries((await SseTester.compile(spec)).program)).toBe(true);
    expect(usesSseLibraries((await Tester.compile(`@service namespace S; op ping(): string;`)).program)).toBe(false);
  });

  it("has no top-level await, so core can be required", () => {
    const src = resolve(import.meta.dirname, "../../src");
    const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
    for (const file of files) {
      const lines = readFileSync(join(src, file), "utf8").split("\n");
      expect(lines.filter((l) => /^(export\s+)?(const|let|var|\w)[^/]*\bawait\b/.test(l)), file).toEqual([]);
    }
    // The module loading the optional peers is synchronous (compiled output).
    const required = createRequire(import.meta.url)(resolve(import.meta.dirname, "../../dist/ir/sse.js")) as Record<string, unknown>;
    expect(typeof required.loadSseLibraries).toBe("function");
  });

  it("builds a typed stream from an @events union", async () => {
    const { program } = await SseTester.compile(spec);
    const ir = buildApiIR(program, withSse);
    const [subscribe] = ir.services[0].groups[0].operations;
    const events = [
      { name: "userconnect", payload: { kind: "named", id: "S.UserConnect" }, contentType: "application/json", terminal: false, docs: "A user joined" },
      { name: "note", payload: { kind: "scalar", name: "string", custom: { id: "S.Note", name: "Note", decorators: {} } }, contentType: "text/plain", terminal: false },
      { name: "count", payload: { kind: "scalar", name: "int32" }, contentType: "application/json", terminal: false },
      { name: "quoted", payload: { kind: "scalar", name: "string" }, contentType: "application/json", terminal: false },
      { name: "wrapped", payload: { kind: "scalar", name: "string" }, contentType: "text/plain", terminal: false },
      { name: "message", payload: { kind: "literal", value: "[done]" }, contentType: "text/plain", terminal: true },
    ];
    expect(subscribe.responses).toEqual([
      {
        statusCodes: 200,
        description: "The request has succeeded.",
        isError: false,
        headers: [],
        body: {
          type: { kind: "named", id: "S.ChannelEvents" },
          contentTypes: ["text/event-stream"],
          stream: { protocol: "sse", events },
        },
      },
    ]);
    const union = ir.types.find((t) => t.id === "S.ChannelEvents") as UnionIR;
    expect(union).toMatchObject({ kind: "union", name: "ChannelEvents", docs: "Channel events", events });
    expect(union.variants.map((v) => [v.name, v.type])).toEqual(events.map((e) => [e.name === "message" ? undefined : e.name, e.payload]));
    // Envelope models of `@data` events are not types of their own.
    expect(ir.types.map((t) => t.id)).toEqual(["S.ChannelEvents", "S.UserConnect"]);
  });

  it("treats any text/event-stream response as an untyped stream", async () => {
    const { program } = await SseTester.compile(spec);
    const raw = buildApiIR(program, withSse).services[0].groups[0].operations[1];
    expect(successBody(raw.responses)).toEqual({
      type: { kind: "scalar", name: "string" },
      contentTypes: ["text/event-stream"],
      stream: { protocol: "sse" },
    });
  });

  it("falls back to untyped streams and warns without the libraries", async () => {
    const { program } = await SseTester.compile(spec);
    const ir = buildApiIR(program);
    const [subscribe, raw] = ir.services[0].groups[0].operations;
    expect(successBody(subscribe.responses)).toEqual({
      type: { kind: "scalar", name: "string" },
      contentTypes: ["text/event-stream"],
      stream: { protocol: "sse" },
    });
    expect(successBody(raw.responses)?.stream).toEqual({ protocol: "sse" });
    // The @events union is a plain union then.
    expect((ir.types.find((t) => t.id === "S.ChannelEvents") as UnionIR).events).toBeUndefined();
    expectDiagnostics(program.diagnostics.filter((d) => d.code.endsWith("sse-libraries-missing")), [
      {
        code: "@abhigyakrishna/tspgen-core/sse-libraries-missing",
        message: /Operation 'S.subscribe' streams typed server-sent events/,
      },
    ]);
  });

  it("does not warn for untyped streams without the libraries", async () => {
    const { program } = await Tester.compile(`
      @service namespace S;
      @route("/raw") op raw(): { @header contentType: "text/event-stream"; @body body: string };
    `);
    const [raw] = buildApiIR(program).services[0].groups[0].operations;
    expect(successBody(raw.responses)?.stream).toEqual({ protocol: "sse" });
    expect(program.diagnostics).toEqual([]);
  });

  it("streams only a single success response without headers", async () => {
    const { program } = await SseTester.compile(`
      @service namespace S;
      model Tick { n: int32 }
      @events union Ticks { tick: Tick }
      @error model Oops { code: string }
      @route("/a") op both(): SSEStream<Ticks> | { @statusCode _: 202; @body queued: Tick } | Oops;
      @route("/b") op withHeader(): { @header("x-id") id: string; ...SSEStream<Ticks> };
      @route("/c") op withError(): SSEStream<Ticks> | Oops;
    `);
    const [both, withHeader, withError] = buildApiIR(program, withSse).services[0].groups[0].operations;
    expect(successBody(both.responses)).toEqual({ type: { kind: "scalar", name: "string" }, contentTypes: ["text/event-stream"] });
    expect(successBody(withHeader.responses)).toEqual({ type: { kind: "scalar", name: "string" }, contentTypes: ["text/event-stream"] });
    expect(successBody(withError.responses)?.stream?.events?.map((e) => e.name)).toEqual(["tick"]);
    expect(withError.responses.find((r) => r.isError)?.body).toEqual({ type: { kind: "named", id: "S.Oops" }, contentTypes: ["application/json"] });
    expectDiagnostics(
      program.diagnostics.filter((d) => d.code.endsWith("unsupported-sse-response")),
      ["S.both", "S.withHeader"].map((op) => ({
        code: "@abhigyakrishna/tspgen-core/unsupported-sse-response",
        message: new RegExp(`Operation '${op.replace(".", "\\.")}' returns a text/event-stream response`),
      })),
    );
  });

  it("does not collect the events union of a stream that cannot stream, nor unused ones", async () => {
    const { program } = await SseTester.compile(`
      @service namespace S;
      model Tick { n: int32 }
      @events union Ticks { tick: Tick }
      @events union Unused { other: string }
      @route("/a") op both(): SSEStream<Ticks> | { @statusCode _: 202; @body queued: Tick };
    `);
    const ir = buildApiIR(program, withSse);
    expect(ir.types.map((t) => t.id)).toEqual(["S.Tick"]);
    expectDiagnostics(program.diagnostics.filter((d) => d.code.endsWith("unsupported-sse-response")), {
      code: "@abhigyakrishna/tspgen-core/unsupported-sse-response",
    });
  });

  it("warns when an @events union is used as a regular type", async () => {
    const { program } = await SseTester.compile(`
      @service namespace S;
      @events union Ticks { tick: int32 }
      model Holder { last: Ticks }
      @route("/t") op ticks(): SSEStream<Ticks>;
      @route("/h") op holder(): Holder;
      @route("/b") @post op body(@body t: Ticks): void;
    `);
    buildApiIR(program, withSse);
    expectDiagnostics(program.diagnostics.filter((d) => d.code.endsWith("events-in-json")), [
      { code: "@abhigyakrishna/tspgen-core/events-in-json", message: /'S.Ticks' is used as a regular type \(in 'S.Holder'\)/ },
      { code: "@abhigyakrishna/tspgen-core/events-in-json", message: /'S.Ticks' is used as a regular type \('S.body'\)/ },
    ]);
  });
});
