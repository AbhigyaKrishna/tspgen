import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { sseNextjs } from "./tester.js";

const spec = `
  using TspGen;
  @service namespace Shop;
  model Item { id: string }
  @events union Ticks { tick: int32 }
  @route("/items") interface Items {
    @get list(): Item[];
    @get @route("/{id}") read(@path id: string): Item;
    @get @route("/watch") watch(): SSEStream<Ticks>;
  }
  @@meta(Shop.Items.read, "typescript:ts-nextjs-client", #{ next: #{ revalidate: 5, tags: #["item"] } });
`;

const dir = mkdtempSync(join(resolve(import.meta.dirname, ".."), ".tmp-run-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const modules = new Map<string, Promise<any>>();

/** Generates, writes and imports one client style once per run. */
function load(style: "grouped" | "flat"): Promise<any> {
  let found = modules.get(style);
  if (!found) {
    found = (async () => {
      const options =
        style === "grouped"
          ? { features: { "react-query": false, "server-actions": false } }
          : { "client-style": "flat", features: { "react-query": false } };
      const { outputs } = await sseNextjs(options).compile(spec);
      for (const [path, content] of Object.entries(outputs)) {
        mkdirSync(dirname(join(dir, style, path)), { recursive: true });
        writeFileSync(join(dir, style, path), content);
      }
      return import(pathToFileURL(join(dir, style, style === "grouped" ? "client/index.ts" : "client.ts")).href);
    })();
    modules.set(style, found);
  }
  return found;
}

/** One call shape for both styles: grouped methods take a params object, flat methods positional arguments. */
interface Api {
  list(options?: object): Promise<unknown>;
  read(id: string, options?: object): Promise<unknown>;
  watch(options?: object): AsyncIterable<unknown>;
}
type Create = (config: object) => Promise<Api>;

const grouped: Create = async (config) => {
  const items = (await load("grouped")).createShopClient({ baseUrl: "http://x", ...config }).items;
  return { list: (o) => items.list(o), read: (id, o) => items.read({ id }, o), watch: (o) => items.watch(o) };
};

const flat: Create = async (config) => {
  const client = new (await load("flat")).ShopClient({ baseUrl: "http://x", ...config });
  return { list: (o) => client.list(o), read: (id, o) => client.read(id, o), watch: (o) => client.watch(o) };
};

type Init = RequestInit & { next?: unknown };
const json = () => vi.fn(async (_url: URL | string, _init?: Init) => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
const initOf = (fetch: { mock: { calls: unknown[][] } }, i = 0): Init => fetch.mock.calls[i]![1] as Init;

const STYLES: [string, Create][] = [
  ["grouped", grouped],
  ["flat", flat],
];

describe.each(STYLES)("%s client RequestInit passthrough (runtime)", (_style, create) => {
  it("passes every RequestInit field of the call's options to fetch", async () => {
    const fetch = json();
    const api = await create({ fetch });
    await api.list({
      credentials: "include",
      keepalive: true,
      cache: "no-store",
      mode: "cors",
      redirect: "manual",
      referrerPolicy: "no-referrer",
      priority: "high",
      integrity: "sha256-x",
      next: { revalidate: 10, tags: ["a"] },
    });
    expect(initOf(fetch)).toMatchObject({
      method: "GET",
      credentials: "include",
      keepalive: true,
      cache: "no-store",
      mode: "cors",
      redirect: "manual",
      referrerPolicy: "no-referrer",
      priority: "high",
      integrity: "sha256-x",
      next: { revalidate: 10, tags: ["a"] },
    });
  });

  it("never lets a smuggled method, body or window from a plain-JS caller reach fetch", async () => {
    const fetch = json();
    const api = await create({ fetch });
    // RequestOptions excludes method/body/window at the type level; a caller outside the type system
    // (plain JS, or an `as` cast) can still put them on the object passed at runtime.
    await api.list({ method: "DELETE", body: "smuggled", window: "smuggled", cache: "no-store" });
    const init = initOf(fetch) as Init & { window?: unknown };
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.window).toBeUndefined();
    expect(init.cache).toBe("no-store");
  });

  it("applies client-wide init under each call's options, replacing next", async () => {
    const fetch = json();
    const api = await create({ fetch, init: { credentials: "include", cache: "force-cache", next: { revalidate: 60 } } });
    await api.list();
    await api.list({ cache: "no-store", next: { tags: ["b"] } });
    expect(initOf(fetch, 0)).toMatchObject({ credentials: "include", cache: "force-cache", next: { revalidate: 60 } });
    expect(initOf(fetch, 1)).toMatchObject({ credentials: "include", cache: "no-store" });
    expect(initOf(fetch, 1).next).toEqual({ tags: ["b"] });
  });

  it("resolves function headers on every request, under the call's headers", async () => {
    const fetch = json();
    const headers = vi.fn(async () => ({ authorization: "Bearer t", "x-a": "client" }));
    const api = await create({ fetch, headers });
    await api.list({ headers: { "x-a": "call" } });
    await api.list();
    expect(headers).toHaveBeenCalledTimes(2);
    const first = new Headers(initOf(fetch, 0).headers);
    expect(first.get("authorization")).toBe("Bearer t");
    expect(first.get("x-a")).toBe("call");
    expect(new Headers(initOf(fetch, 1).headers).get("x-a")).toBe("client");
  });

  it("asks streams for text/event-stream alongside the caller's options", async () => {
    const fetch = vi.fn(
      async (_url: URL | string, _init?: Init) =>
        new Response("event: tick\ndata: 1\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const api = await create({ fetch });
    const controller = new AbortController();
    const events: unknown[] = [];
    for await (const event of api.watch({ signal: controller.signal, cache: "no-store", headers: { "x-a": "1" } })) events.push(event);
    expect(events).toEqual([{ event: "tick", data: 1 }]);
    const init = initOf(fetch);
    expect(init.signal).toBe(controller.signal);
    expect(init.cache).toBe("no-store");
    const sent = new Headers(init.headers);
    expect(sent.get("accept")).toBe("text/event-stream");
    expect(sent.get("x-a")).toBe("1");
  });
});

const META_STYLES: [string, Create][] = [
  ["grouped", grouped],
  ["flat", flat],
];

describe.each(META_STYLES)("%s client @meta next (runtime)", (_style, create) => {
  it("sends @meta next over init, replaced by the call's next", async () => {
    const fetch = json();
    const api = await create({ fetch, init: { next: { revalidate: 1 } } });
    await api.read("a");
    await api.read("a", { next: { revalidate: 0 } });
    await api.list();
    expect(initOf(fetch, 0).next).toEqual({ revalidate: 5, tags: ["item"] });
    expect(initOf(fetch, 1).next).toEqual({ revalidate: 0 });
    expect(initOf(fetch, 2).next).toEqual({ revalidate: 1 });
  });
});
