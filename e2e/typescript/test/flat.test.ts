import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError, PetFeedClient } from "../generated/flat";
import { startStubServer } from "./stub-server";

let server: Server;
let requests: string[];
let api: PetFeedClient;
let baseUrl: string;

beforeAll(async () => {
  const stub = await startStubServer();
  server = stub.server;
  requests = stub.requests;
  baseUrl = stub.url;
  api = new PetFeedClient({ baseUrl });
});

afterAll(() => {
  server.close();
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("generated flat client streams against a stub server", () => {
  it("decodes typed events up to the terminal one and untyped messages", async () => {
    const feed = [
      { event: "added", data: { id: 1, name: "Rex", species: "dog", born_at: "2020-01-01T00:00:00Z" } },
      { event: "note", data: "line one\nline two" },
      { event: "count", data: 3 },
      { event: "seen", data: "2026-09-27T10:00:00.123Z" },
      { event: "message", data: "[done]" },
    ];
    expect(await collect(api.watch())).toEqual(feed);
    expect(await collect(api.watchPlugin({}))).toEqual(feed);
    expect(await collect(api.raw({ count: 2 }))).toEqual([
      { data: "message 0", id: "0" },
      { data: "message 1", event: "custom", id: "1" },
    ]);
  });

  it("throws ApiError before streaming and aborts mid-stream", async () => {
    const error = await collect(api.watch({ fail: 404 })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).body).toEqual({ message: "no feed" });

    const closedBefore = requests.filter((r) => r === "closed /feed").length;
    const controller = new AbortController();
    const seen: unknown[] = [];
    const run = (async () => {
      for await (const event of api.watch({ endless: true }, { signal: controller.signal })) {
        seen.push(event);
        if (seen.length === 2) controller.abort();
      }
    })();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toEqual([0, 1].map((n) => ({ event: "count", data: n })));
    await expect.poll(() => requests.filter((r) => r === "closed /feed").length).toBe(closedBefore + 1);
  });

  it("resolves async headers per request and passes init, per-call options and @meta next to fetch", async () => {
    const seen: (RequestInit & { next?: unknown })[] = [];
    let calls = 0;
    const spy = new PetFeedClient({
      baseUrl,
      headers: async () => ({ authorization: `Bearer ${++calls}` }),
      init: { credentials: "include" },
      fetch: (input, init) => {
        seen.push(init ?? {});
        return fetch(input, init);
      },
    });
    // The stub returns pet 13 as-is; the flat client does not validate responses.
    expect(await spy.getPet(13)).toEqual({ id: 13, species: "dog" });
    await spy.getPet(13, { cache: "no-store", next: { revalidate: 0 }, headers: { "x-call": "1" } });
    expect(new Headers(seen[0]!.headers).get("authorization")).toBe("Bearer 1");
    expect(seen[0]!.credentials).toBe("include");
    expect(seen[0]!.next).toEqual({ revalidate: 30, tags: ["pet"] });
    const second = new Headers(seen[1]!.headers);
    expect(second.get("authorization")).toBe("Bearer 2");
    expect(second.get("x-call")).toBe("1");
    expect(seen[1]!.cache).toBe("no-store");
    expect(seen[1]!.credentials).toBe("include");
    expect(seen[1]!.next).toEqual({ revalidate: 0 });
  });
});
