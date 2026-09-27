import { expectDiagnostics } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { nextjs, sseNextjs } from "./tester.js";
import { typecheck } from "./typecheck.js";

const SHIPYARD_FLAGS = {
  exactOptionalPropertyTypes: true,
  noUncheckedIndexedAccess: true,
  noImplicitOverride: true,
  noFallthroughCasesInSwitch: true,
};

export const sseSpec = `
  @service namespace Chat;
  model UserConnect { username: string }
  @error model Oops { code: string }
  @events union ChannelEvents {
    userConnect: UserConnect,
    @Events.contentType("text/plain") note: string,
    @Events.contentType("text/plain") count: int32,
    @Events.contentType("text/plain") @terminalEvent "[done]",
  }
  @route("/feed") interface Feed {
    @get watch(@query room: string): SSEStream<ChannelEvents> | Oops;
    @post @route("/{id}") publish(@path id: string, @body u: UserConnect): SSEStream<ChannelEvents>;
    @get @route("/raw") raw(): { @header contentType: "text/event-stream"; @body body: string };
    @get @route("/last") last(): UserConnect;
  }
`;

const EVENTS =
  '[{ event: "userConnect", data: "json" }, { event: "note", data: "text" }, { event: "count", data: "number" }, { event: "message", data: "text", literal: "[done]", value: "[done]", terminal: true }]';

describe("server-sent events (grouped client)", () => {
  it("generates async generator methods that stream after the usual request and error handling", async () => {
    const { outputs } = await sseNextjs({}, { features: { zod: true } }).compile(sseSpec);
    const feed = outputs["client/feed.ts"];
    expect(feed).toContain(`  async *watch(params: FeedWatchParams, options?: RequestOptions): AsyncIterable<ChannelEvents> {
    const res = await request(
      this.config,
      {
        method: "GET",
        path: "/feed",
        query: [["room", params.room, false]],
        accept: "text/event-stream",
      },
      options,
    );
    if (res.ok) return yield* streamEvents(this.config, res, ${EVENTS}, z.lazy(() => ChannelEventsSchema));
    throw await toError(res, {
      default: (status, body) => new OopsError(status, body as Oops),
    });
  }`);
    expect(feed).toContain(`  async *raw(options?: RequestOptions): AsyncIterable<SseMessage> {`);
    expect(feed).toContain(`    if (res.ok) return yield* streamEvents(this.config, res, undefined);`);
    expect(feed).toContain(`import { parse, request, streamEvents, toError } from "./core";`);
    const core = outputs["client/core.ts"];
    expect(core).toContain("export async function* readEvents(body: ReadableStream<Uint8Array> | null): AsyncGenerator<RawEvent, void, undefined> {");
    expect(core).toContain("export async function* streamEvents<T>(");
    expect(core).toContain(`  if (spec.accept !== undefined && !headers.has("accept")) headers.set("accept", spec.accept);`);
  });

  it("skips streaming operations in hooks and Server Actions", async () => {
    const [{ outputs }, diagnostics] = await sseNextjs({}, { features: { zod: true } }).compileAndDiagnose(sseSpec);
    expectDiagnostics(diagnostics, []);
    const hooks = outputs["client/react-query/hooks.ts"];
    expect(hooks).toContain("useFeedLastQuery");
    for (const name of ["Watch", "Publish", "Raw"]) expect(hooks).not.toContain(`useFeed${name}`);
    expect(outputs["client/actions/feed.ts"]).toBeUndefined();
  });

  it("keeps the core runtime unchanged without streams", async () => {
    const { outputs } = await nextjs({}, { features: { zod: true } }).compile(`@service namespace S; @route("/p") op ping(): string;`);
    expect(outputs["client/core.ts"]).not.toContain("accept");
    expect(outputs["client/core.ts"]).not.toContain("readEvents");
  });

  it("type-checks under shipyard's compiler flags", async () => {
    for (const layout of ["per-type", "single-file"]) {
      const { outputs } = await sseNextjs({ features: { "server-actions": false } }, { features: { zod: true }, layout }).compile(sseSpec);
      expect(typecheck(outputs, SHIPYARD_FLAGS)).toBe("");
    }
    const { outputs } = await sseNextjs({ features: { "server-actions": false } }).compile(sseSpec);
    expect(typecheck(outputs, SHIPYARD_FLAGS)).toBe("");
  });
});

describe("server-sent events (flat client)", () => {
  const flat = { "client-style": "flat" };

  it("streams through async generator methods taking an abort signal", async () => {
    const { outputs } = await sseNextjs(flat, { layout: "single-file" }).compile(sseSpec);
    const client = outputs["client.ts"];
    expect(client).toContain(`  async *watch(query: { room: string }, init?: RequestOptions): AsyncIterable<ChannelEvents> {
    const response = await this.request("GET", \`/feed\${toQuery(query)}\`, undefined, { ...init, accept: "text/event-stream" });
    yield* decodeEvents(response.body, ${EVENTS}) as AsyncIterable<ChannelEvents>;
  }`);
    expect(client).toContain(`  async *publish(id: string, u: UserConnect, init?: RequestOptions): AsyncIterable<ChannelEvents> {
    const response = await this.request("POST", \`/feed/\${encodeURIComponent(String(id))}\`, u, { ...init, accept: "text/event-stream" });`);
    expect(client).toContain(`    yield* decodeEvents(response.body, undefined) as AsyncIterable<SseMessage>;`);
    // The flat methods' shared init parameter: request() takes the stream's Accept header next to the caller's options.
    expect(client).toContain(
      "  private async request(method: string, path: string, body?: unknown, init: RequestOptions & { accept?: string } = {}): Promise<Response> {\n    const { accept, ...options } = init;\n",
    );
    expect(client).toContain(`    if (accept !== undefined && !headers.has("accept")) headers.set("accept", accept);`);
    expect(client).toContain("      ...safeInit(options),\n      method,\n");
    // No zod: the flat client does not validate responses.
    expect(client).not.toContain("Schema");
  });

  it("names the init parameter around taken names", async () => {
    const { outputs } = await sseNextjs(flat, { layout: "single-file" }).compile(`
      @service namespace S;
      @events union E { tick: int32 }
      @route("/{init}") op watch(@path \`init\`: string, @query requestInit?: string): SSEStream<E>;
    `);
    expect(outputs["client.ts"]).toContain("async *watch(init: string, query: { requestInit?: string } = {}, requestInit?: RequestOptions): AsyncIterable<E> {");
  });

  it("keeps clients without streams unchanged", async () => {
    const { outputs } = await nextjs(flat, { layout: "single-file" }).compile(`@service namespace S; model P { a: string } @post op make(@body p: P): P;`);
    expect(outputs["client.ts"]).toContain(
      "  private async request(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<Response> {",
    );
    expect(outputs["client.ts"]).not.toContain("readEvents");
  });

  it.each(["EventSpec", "RawEvent", "readEvents", "decodeEvents", "TextDecoder", "ReadableStream"])(
    "reports a generated type named like the stream helper %s",
    async (name) => {
      const [result, diagnostics] = await sseNextjs(flat, { layout: "single-file" }).compileAndDiagnose(
        `using TspGen;\n${sseSpec}\n@TS.name("${name}") model Clash { x: string }`,
      );
      expectDiagnostics(diagnostics, {
        code: "@abhigyakrishna/tspgen-typescript/flat-client-name-clash",
        message: `Generated type '${name}' clashes with a name the flat client uses internally ('${name}'); rename it with @TS.name.`,
      });
      expect(result.outputs["client.ts"]).toBeUndefined();
    },
  );

  it("leaves streaming operations out of the flat React Query hooks", async () => {
    const { outputs } = await sseNextjs({ ...flat, features: { "react-query": true } }, { layout: "single-file" }).compile(sseSpec);
    const generated = outputs["queries.ts"]! + outputs["hooks.ts"]!;
    expect(generated).toContain("    last: () => [\"Chat\", \"feed\", \"last\"] as const,\n");
    expect(generated).toContain("export function useLastQuery(");
    for (const name of ["watch", "publish", "raw", "Watch", "Publish", "Raw", "ChannelEvents", "SseMessage"]) {
      expect(generated).not.toContain(name);
    }
    expect(typecheck(outputs, SHIPYARD_FLAGS)).toBe("");
    // With @useAuth too; a stream op whose Vars keys would clash is skipped silently (it has no hooks anyway).
    const [secure, diagnostics] = await sseNextjs({ ...flat, features: { "react-query": true } }, { layout: "single-file" }).compileAndDiagnose(
      sseSpec.replace("@service namespace Chat;", "@service @useAuth(BearerAuth) namespace Chat;").replace(
        '@get @route("/raw") raw()',
        '@post @route("/raw/{body}") raw(@path body: string, @body b: UserConnect)',
      ),
    );
    expect(diagnostics.filter((d) => d.code.endsWith("flat-react-query-skipped"))).toEqual([]);
    expect(secure.outputs["hooks.ts"]).not.toContain("Raw");
    expect(typecheck(secure.outputs, SHIPYARD_FLAGS)).toBe("");
  });

  it("type-checks under shipyard's compiler flags, with and without validate", async () => {
    for (const options of [{ ...flat, features: { validate: false } }, { ...flat, features: { validate: true } }]) {
      const { outputs } = await sseNextjs(options, { layout: "single-file", features: { zod: true } }).compile(sseSpec);
      expect(typecheck(outputs, SHIPYARD_FLAGS)).toBe("");
    }
  });
});
