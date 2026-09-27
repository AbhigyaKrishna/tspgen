import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { nextjs } from "./tester.js";

const spec = `
  @service @useAuth(BearerAuth) namespace Shop;
  model Key is ApiKeyAuth<ApiKeyLocation.query, "api-key">;
  model Session is ApiKeyAuth<ApiKeyLocation.cookie, "sid">;
  model Partner is ApiKeyAuth<ApiKeyLocation.header, "X-Partner">;
  @route("/items") interface Items {
    @get list(@query q?: string): string[];
    @post @useAuth(NoAuth) open(): void;
    @get @route("/basic") @useAuth(BasicAuth | Key | NoAuth) either(@query q?: string): void;
    @get @route("/both") @useAuth([Session, Partner]) both(): void;
    @get @route("/cookie") @useAuth(Session) cookie(@cookie theme?: string): void;
    @get @route("/dup") @useAuth(Key) dup(@query("api-key") apiKey?: string, @query q?: string): void;
  }
`;

const dir = mkdtempSync(join(resolve(import.meta.dirname, ".."), ".tmp-run-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(sub: string, outputs: Record<string, string>): string {
  for (const [path, content] of Object.entries(outputs)) {
    mkdirSync(dirname(join(dir, sub, path)), { recursive: true });
    writeFileSync(join(dir, sub, path), content);
  }
  return join(dir, sub);
}

type Call = [URL | string, RequestInit];
const ok = () => vi.fn(async () => new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } }));
const sent = (fetch: ReturnType<typeof vi.fn>, i = 0) => {
  const [url, init] = fetch.mock.calls[i] as unknown as Call;
  return { url: String(url), headers: new Headers(init.headers) };
};

async function grouped() {
  const { outputs } = await nextjs({ "react-query": false, "server-actions": false }).compile(spec);
  const mod = await import(pathToFileURL(join(write("grouped", outputs), "client/index.ts")).href);
  return (fetch: typeof globalThis.fetch, auth?: object, headers?: Record<string, string>) =>
    mod.createShopClient({ baseUrl: "http://x", fetch, auth, headers }).items;
}

async function flat() {
  const { outputs } = await nextjs({ "client-style": "flat" }).compile(spec.replace("@cookie theme?: string", ""));
  const mod = await import(pathToFileURL(join(write("flat", outputs), "client.ts")).href);
  return (fetch: typeof globalThis.fetch, auth?: object, headers?: Record<string, string>) =>
    new mod.ShopClient({ baseUrl: "http://x", fetch, auth, headers });
}

// Both styles take query parameters as one object.
const query = (q: string) => [{ q }];

describe.each([
  ["grouped", grouped],
  ["flat", flat],
])("%s client auth (runtime)", (style, load) => {
  it("sends a bearer token from an async provider, over config headers", async () => {
    const client = await load();
    const fetch = ok();
    await client(fetch, { BearerAuth: async () => "tok" }, { authorization: "old", "x-other": "1" }).list(...query("a b"));
    const { url, headers } = sent(fetch);
    expect(url).toBe("http://x/items?q=a+b");
    expect(headers.get("authorization")).toBe("Bearer tok");
    expect(headers.get("x-other")).toBe("1");
  });

  it("sends nothing without providers, for NoAuth operations, or when a provider returns undefined", async () => {
    const client = await load();
    const fetch = ok();
    await client(fetch).list();
    await client(fetch, { BearerAuth: () => "tok" }).open();
    await client(fetch, { BearerAuth: () => undefined }).list();
    for (let i = 0; i < 3; i++) expect(sent(fetch, i).headers.has("authorization")).toBe(false);
  });

  it("picks the first satisfied alternative: basic (UTF-8), else an API key merged into the query", async () => {
    const client = await load();
    const fetch = ok();
    await client(fetch, { BasicAuth: () => ({ username: "ü", password: "p:w" }), Key: () => "k" }).either(...query("x"));
    await client(fetch, { BasicAuth: () => undefined, Key: async () => "k&1" }).either(...query("x"));
    await client(fetch, {}).either();
    expect(sent(fetch, 0).headers.get("authorization")).toBe(`Basic ${Buffer.from("ü:p:w").toString("base64")}`);
    expect(sent(fetch, 0).url).toBe("http://x/items/basic?q=x");
    expect(sent(fetch, 1).headers.has("authorization")).toBe(false);
    expect(sent(fetch, 1).url).toBe("http://x/items/basic?q=x&api-key=k%261");
    expect(sent(fetch, 2).url).toBe("http://x/items/basic");
  });

  it("sends every scheme of an alternative, only when all are provided, asking each provider once", async () => {
    const client = await load();
    const fetch = ok();
    const session = vi.fn(() => "s 1");
    await client(fetch, { Session: session, Partner: () => "p" }, { cookie: "a=b" }).both();
    await client(fetch, { Session: () => "s" }).both();
    expect(session).toHaveBeenCalledTimes(1);
    expect(sent(fetch, 0).headers.get("x-partner")).toBe("p");
    expect(sent(fetch, 0).headers.get("cookie")).toBe("a=b; sid=s%201");
    expect(sent(fetch, 1).headers.has("cookie")).toBe(false);
    expect(sent(fetch, 1).headers.has("x-partner")).toBe(false);
  });

  it("replaces a query parameter named like the API key, keeping the others", async () => {
    const client = await load();
    const fetch = ok();
    // Grouped params use the parameter name, the flat query object the wire name.
    await client(fetch, { Key: () => "k" }).dup(style === "grouped" ? { apiKey: "old", q: "x" } : { "api-key": "old", q: "x" });
    expect(sent(fetch).url).toBe("http://x/items/dup?api-key=k&q=x");
  });

  it("treats empty-string credentials as absent, trying the next alternative", async () => {
    const client = await load();
    const fetch = ok();
    await client(fetch, { BearerAuth: () => "" }).list();
    await client(fetch, { BasicAuth: () => undefined, Key: async () => "" }).either();
    await client(fetch, { Session: () => "", Partner: () => "p" }).both();
    await client(fetch, { BasicAuth: () => undefined, Key: () => "k" }).either();
    expect(sent(fetch, 0).headers.has("authorization")).toBe(false);
    expect(sent(fetch, 1).url).toBe("http://x/items/basic");
    expect(sent(fetch, 2).headers.has("x-partner")).toBe(false);
    expect(sent(fetch, 2).headers.has("cookie")).toBe(false);
    expect(sent(fetch, 3).url).toBe("http://x/items/basic?api-key=k");
  });

  it("ignores inherited object keys as providers", async () => {
    const client = await load();
    const fetch = ok();
    await client(fetch, Object.create({ BearerAuth: () => "inherited" })).list();
    expect(sent(fetch).headers.has("authorization")).toBe(false);
  });
});

describe("grouped client auth (runtime)", () => {
  it("lets per-call headers override generated credentials", async () => {
    const client = await grouped();
    const fetch = ok();
    await client(fetch, { BearerAuth: () => "tok" }, { authorization: "config" }).list({}, { headers: { Authorization: "Bearer mine" } });
    await client(fetch, { Session: () => "s", Partner: () => "p" }).both({ headers: { "x-partner": "call" } });
    expect(sent(fetch, 0).headers.get("authorization")).toBe("Bearer mine");
    expect(sent(fetch, 1).headers.get("x-partner")).toBe("call");
  });


  it("merges an API key cookie with cookie parameters into one header", async () => {
    const client = await grouped();
    const fetch = ok();
    await client(fetch, { Session: () => "s" }).cookie({ theme: "dark" });
    expect(sent(fetch).headers.get("cookie")).toBe("theme=dark; sid=s");
  });
});
