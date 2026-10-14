import { Effect, Fiber, Stream } from "effect";
import { afterAll, describe, expect, it, vi } from "vitest";
import { cleanup, load } from "../../typescript/test/tsc.js";
import { nextjs, petSpec, sseNextjs } from "./tester.js";
import { typecheck } from "./typecheck.js";

afterAll(cleanup);

const spec = `
  @service namespace Shop;
  model Pet { id: int32; @minLength(2) name: string }
  @error model Missing { @statusCode _: 404; message: string }
  @route("/pets") interface Pets {
    @get get(@path id: int32): Pet | Missing;
    @post create(@body pet: Pet, @query limit?: int32): Pet;
    @get list(@query limit?: int32): Pet[];
    @delete remove(@path id: int32): void;
  }
`;
const features = { effect: true, "react-query": false, "server-actions": false };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Effect clients", () => {
  it("emits no Effect dependency by default", async () => {
    const { outputs } = await nextjs({ features: { "react-query": false, "server-actions": false } }).compile(spec);
    expect(outputs["client/effect.ts"]).toBeUndefined();
    expect(Object.values(outputs).join("\n")).not.toContain('from "effect"');
  });

  it.each(["grouped", "flat"])(
    "type-checks %s with independent feature switches and strict optional types",
    async (style) => {
      for (const schemas of [false, true]) {
        const { outputs } = await nextjs(
          { "client-style": style, features },
          { features: { effect: schemas } },
        ).compile(spec);
        expect(typecheck(outputs, { exactOptionalPropertyTypes: true })).toBe("");
      }
    },
  );

  it("type-checks grouped multi-status responses, headers, Zod and separate output directories", async () => {
    const { outputs } = await nextjs(
      { features, "output-dir": "sdk" },
      { features: { effect: true, zod: true }, layout: "single-file" },
    ).compile(petSpec);
    expect(typecheck(outputs, { exactOptionalPropertyTypes: true })).toBe("");
  });

  it.each(["grouped", "flat"])(
    "runs %s methods lazily with their original arguments and typed HTTP failures",
    async (style) => {
      const { outputs } = await nextjs({ "client-style": style, features }, { features: { effect: true } }).compile(
        spec,
      );
      const { createShopEffectClient, EffectClientError } = await load(
        outputs,
        style === "flat" ? "effect.ts" : "client/index.ts",
      );
      const fetch = vi.fn(async (_url: unknown, init: RequestInit) =>
        init.method === "DELETE" ? new Response(null, { status: 204 }) : json({ id: 1, name: "Rex" }),
      );
      const client = createShopEffectClient({ baseUrl: "http://x", fetch });
      const api = style === "flat" ? client : client.pets;
      const task = style === "flat" ? api.get(1) : api.get({ id: 1 });
      expect(fetch).not.toHaveBeenCalled();
      expect(await Effect.runPromise(task)).toEqual({ id: 1, name: "Rex" });
      await Effect.runPromise(task);
      expect(fetch).toHaveBeenCalledTimes(2);
      const options = { headers: { "x-test": "yes" }, cache: "no-store" };
      await Effect.runPromise(
        style === "flat"
          ? api.create({ id: 1, name: "Rex" }, undefined, options)
          : api.create({ pet: { id: 1, name: "Rex" } }, options),
      );
      expect(new Headers(fetch.mock.calls[2][1].headers).get("x-test")).toBe("yes");
      expect(fetch.mock.calls[2][1].cache).toBe("no-store");
      expect(JSON.parse(String(fetch.mock.calls[2][1].body))).toEqual({ id: 1, name: "Rex" });
      expect(await Effect.runPromise(style === "flat" ? api.remove(1) : api.remove({ id: 1 }))).toBeUndefined();
      fetch.mockImplementationOnce(async () => json({ message: "missing" }, 404));
      const error = await Effect.runPromise(Effect.flip(style === "flat" ? api.get(2) : api.get({ id: 2 })));
      expect(error).toMatchObject({ status: 404 });
      expect(error).not.toBeInstanceOf(EffectClientError);
      fetch.mockImplementationOnce(async () => json({ id: 1, name: "a" }));
      expect(await Effect.runPromise(Effect.flip(task))).toBeInstanceOf(EffectClientError);
      const cause = new TypeError("network failed");
      fetch.mockRejectedValueOnce(cause);
      expect(await Effect.runPromise(Effect.flip(task))).toMatchObject({ _tag: "EffectClientError", cause });
    },
  );

  it("aborts fetch on fiber interruption and honors the caller's AbortSignal", async () => {
    const { outputs } = await nextjs({ features }, { features: { effect: true } }).compile(spec);
    const { createShopEffectClient } = await load(outputs, "client/index.ts");
    let signal: AbortSignal | undefined;
    const fetch = vi.fn(
      (_url: unknown, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init.signal!;
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        }),
    );
    const api = createShopEffectClient({ baseUrl: "http://x", fetch });
    const fiber = Effect.runFork(api.pets.get({ id: 1 }));
    await vi.waitFor(() => expect(signal).toBeDefined());
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(signal!.aborted).toBe(true);
    signal = undefined;
    const controller = new AbortController();
    const result = Effect.runPromise(Effect.flip(api.pets.get({ id: 1 }, { signal: controller.signal })));
    await vi.waitFor(() => expect(signal).toBeDefined());
    controller.abort();
    expect(await result).toMatchObject({ _tag: "EffectClientError" });
    expect(signal!.aborted).toBe(true);
  });

  it.each(["grouped", "flat"])("emits lazy %s SSE Streams and aborts after early termination", async (style) => {
    const { outputs } = await sseNextjs({ "client-style": style, features }, { features: { effect: true } }).compile(`
      @service namespace Feed;
      model Tick { count: int32 }
      @events union Ticks { tick: Tick }
      @route("/ticks") op watch(@query limit?: int32): SSEStream<Ticks>;
    `);
    expect(typecheck(outputs, { exactOptionalPropertyTypes: true })).toBe("");
    const { createFeedEffectClient } = await load(outputs, style === "flat" ? "effect.ts" : "client/index.ts");
    let signal: AbortSignal | undefined;
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      signal = init.signal!;
      return new Response('event: tick\ndata: {"count":1}\n\nevent: tick\ndata: {"count":2}\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const api = createFeedEffectClient({ baseUrl: "http://x", fetch });
    const stream = style === "flat" ? api.watch() : api.feed.watch();
    expect(fetch).not.toHaveBeenCalled();
    expect(await Effect.runPromise(stream.pipe(Stream.take(1), Stream.runCollect))).toEqual([
      { event: "tick", data: { count: 1 } },
    ]);
    expect(signal!.aborted).toBe(true);
  });

  it("interrupts an SSE request while it is waiting for the response", async () => {
    const { outputs } = await sseNextjs({ features }, { features: { effect: true } }).compile(`
      @service namespace Feed;
      @events union Events { message: string }
      @route("/events") op watch(): SSEStream<Events>;
    `);
    const { createFeedEffectClient } = await load(outputs, "client/index.ts");
    let signal: AbortSignal | undefined;
    const fetch = vi.fn(
      (_url: unknown, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init.signal!;
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        }),
    );
    const api = createFeedEffectClient({ baseUrl: "http://x", fetch });
    const fiber = Effect.runFork(Stream.runDrain(api.feed.watch()));
    await vi.waitFor(() => expect(signal).toBeDefined());
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(signal!.aborted).toBe(true);
  });

  it("accepts models named after Effect imports and rejects companion export collisions", async () => {
    const { outputs } = await nextjs({ features }, { features: { effect: true } }).compile(`
      @service namespace Shop;
      model Effect { value: string }
      @route("/value") op get(): Effect;
    `);
    expect(typecheck(outputs)).toBe("");
    const diagnostics = await nextjs({ features }, { features: { effect: true } }).diagnose(`
      @service namespace Shop;
      model ShopEffectClient { value: string }
      @route("/value") op get(): ShopEffectClient;
    `);
    expect(diagnostics.some((d) => d.code === "@abhigyakrishna/tspgen-typescript/effect-client-name-clash")).toBe(true);
    for (const errorClass of ["Effect", "EffectClientError", "withSignal"]) {
      const clashes = await nextjs(
        { "client-style": "flat", "error-class": errorClass, features },
        { features: { effect: true } },
      ).diagnose(spec);
      expect(clashes.some((d) => d.code === "@abhigyakrishna/tspgen-typescript/effect-client-name-clash")).toBe(true);
    }
  });
});
