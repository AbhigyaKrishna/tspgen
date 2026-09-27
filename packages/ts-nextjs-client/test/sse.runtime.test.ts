import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { sseNextjs } from "./tester.js";

const spec = `
  @service namespace Chat;
  model UserConnect { username: string }
  @error model Oops { code: string }
  @events union ChannelEvents {
    userConnect: UserConnect,
    @Events.contentType("text/plain") note: string,
    @Events.contentType("text/plain") count: int32,
    @Events.contentType("text/plain") flag: boolean,
    @Events.contentType("text/plain") @terminalEvent "[done]",
  }
  @route("/feed") interface Feed {
    @get watch(@query room: string): SSEStream<ChannelEvents> | Oops;
    @get @route("/raw") raw(): { @header contentType: "text/event-stream"; @body body: string };
  }
`;

const dir = mkdtempSync(join(resolve(import.meta.dirname, ".."), ".tmp-run-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function write(sub: string, outputs: Record<string, string>): Promise<string> {
  for (const [path, content] of Object.entries(outputs)) {
    mkdirSync(dirname(join(dir, sub, path)), { recursive: true });
    writeFileSync(join(dir, sub, path), content);
  }
  return join(dir, sub);
}

async function loadGrouped() {
  const { outputs } = await sseNextjs({ features: { "react-query": false, "server-actions": false } }, { features: { zod: true } }).compile(spec);
  return import(pathToFileURL(join(await write("grouped", outputs), "client/index.ts")).href);
}

async function loadFlat() {
  const { outputs } = await sseNextjs({ "client-style": "flat" }, { layout: "single-file" }).compile(spec);
  return import(pathToFileURL(join(await write("flat", outputs), "client.ts")).href);
}

const WIRE = [
  ": comment\r\nretry: 3000\r\n",
  "event: unknown\r\ndata: {}\r\n\r\n",
  'event: userConnect\r\ndata: {"username":"ann"}\r\n\r\n',
  "event: note\ndata: line one\ndata:line two\n\n",
  "event: note\rdata: café 日本\r\r",
  "event: count\nid: 7\ndata: 42\n\n",
  "data: [done]\n\n",
  "event: count\ndata: 43\n\n",
].join("");

const EXPECTED = [
  { event: "userConnect", data: { username: "ann" } },
  { event: "note", data: "line one\nline two" },
  { event: "note", data: "café 日本" },
  { event: "count", data: 42 },
  { event: "message", data: "[done]" },
];

/** A streamed body written `size` bytes at a time (CRLFs and UTF-8 characters split across chunks). */
function body(text: string, size: number, onCancel?: () => void): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
    cancel() {
      onCancel?.();
    },
  });
}

/** A body that sends one event and then stays open until the request's signal aborts. */
function endless(signal: AbortSignal | null | undefined, onCancel: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("event: count\ndata: 1\n\n"));
      signal?.addEventListener("abort", () => controller.error(signal.reason));
    },
    cancel: onCancel,
  });
}

const stream = (b: ReadableStream<Uint8Array>) => new Response(b, { status: 200, headers: { "content-type": "text/event-stream" } });

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("grouped client streams (runtime)", () => {
  it.each([1, 2, 3, 7, 4096])("decodes typed events from %i-byte chunks and stops at the terminal event", async (size) => {
    const { createChatClient } = await loadGrouped();
    const fetch = vi.fn(async () => stream(body(WIRE, size)));
    const api = createChatClient({ baseUrl: "http://x", fetch, headers: { authorization: "t" } });
    expect(await collect(api.feed.watch({ room: "a b" }))).toEqual(EXPECTED);
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("http://x/feed?room=a+b");
    expect(new Headers(init.headers).get("accept")).toBe("text/event-stream");
    expect(new Headers(init.headers).get("authorization")).toBe("t");
  });

  it("is lazy: nothing is requested until iteration starts", async () => {
    const { createChatClient } = await loadGrouped();
    const fetch = vi.fn(async () => stream(body(WIRE, 5)));
    const events = createChatClient({ baseUrl: "http://x", fetch }).feed.watch({ room: "a" });
    expect(fetch).not.toHaveBeenCalled();
    await collect(events);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("throws the typed error for a non-2xx response before streaming", async () => {
    const { createChatClient } = await loadGrouped();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ code: "nope" }), { status: 403, headers: { "content-type": "application/json" } }));
    const error = await collect(createChatClient({ baseUrl: "http://x", fetch }).feed.watch({ room: "a" })).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 403, error: { code: "nope" } });
  });

  it("validates events with zod unless validation is off", async () => {
    const { createChatClient } = await loadGrouped();
    const bad = 'event: userConnect\ndata: {"name":"x"}\n\n';
    const fetch = vi.fn(async () => stream(body(bad, 64)));
    await expect(collect(createChatClient({ baseUrl: "http://x", fetch }).feed.watch({ room: "a" }))).rejects.toBeInstanceOf(ZodError);
    const lenient = createChatClient({ baseUrl: "http://x", fetch, validate: false });
    expect(await collect(lenient.feed.watch({ room: "a" }))).toEqual([{ event: "userConnect", data: { name: "x" } }]);
  });

  it("yields untyped messages with their event name and id", async () => {
    const { createChatClient } = await loadGrouped();
    const fetch = vi.fn(async () => stream(body("data: a\n\nevent: e\nid: 1\ndata: b\ndata: c\n\ndata: unterminated", 4)));
    expect(await collect(createChatClient({ baseUrl: "http://x", fetch }).feed.raw())).toEqual([
      { data: "a" },
      { data: "b\nc", event: "e", id: "1" },
    ]);
  });

  it("cancels the body when iteration stops early", async () => {
    const { createChatClient } = await loadGrouped();
    const cancel = vi.fn();
    const fetch = vi.fn(async () => stream(body(WIRE, 8, cancel)));
    for await (const event of createChatClient({ baseUrl: "http://x", fetch }).feed.watch({ room: "a" })) {
      expect(event).toEqual(EXPECTED[0]);
      break;
    }
    expect(cancel).toHaveBeenCalled();
  });

  it("aborts mid-stream through RequestOptions.signal", async () => {
    const { createChatClient } = await loadGrouped();
    const fetch = vi.fn(async (_url: URL, init: RequestInit) => stream(endless(init.signal, () => undefined)));
    const controller = new AbortController();
    const seen: unknown[] = [];
    const run = (async () => {
      for await (const event of createChatClient({ baseUrl: "http://x", fetch }).feed.watch({ room: "a" }, { signal: controller.signal })) {
        seen.push(event);
        controller.abort(new Error("stop"));
      }
    })();
    await expect(run).rejects.toThrow("stop");
    expect(seen).toEqual([{ event: "count", data: 1 }]);
  });
});

describe("stream decoding edge cases (runtime)", () => {
  const run = async (wire: string, size = 4096) => {
    const { createChatClient } = await loadGrouped();
    const fetch = vi.fn(async () => stream(body(wire, size)));
    return collect(createChatClient({ baseUrl: "http://x", fetch, validate: false }).feed.watch({ room: "a" }));
  };

  it("skips a leading byte order mark, also split across chunks", async () => {
    for (const size of [1, 2, 4096]) {
      expect(await run("\uFEFFevent: count\ndata: 5\n\nevent: flag\ndata: false\n\n", size)).toEqual([
        { event: "count", data: 5 },
        { event: "flag", data: false },
      ]);
    }
  });

  it.each([
    ["event: count\ndata: 1x\n\n", "Invalid number in event data: \"1x\""],
    ["event: count\ndata: \n\n", "Invalid number in event data: \"\""],
    ["event: flag\ndata: yes\n\n", "Invalid boolean in event data: \"yes\""],
    ['event: userConnect\ndata: {"username":\n\n', "JSON"],
  ])("throws on malformed text or JSON data (%j), ending the iteration", async (wire, message) => {
    await expect(run(`event: count\ndata: 1\n\n${wire}event: count\ndata: 2\n\n`)).rejects.toThrow(message);
  });

  it("fails lines and event data over 1 MiB", async () => {
    const long = "x".repeat((1 << 20) + 1);
    await expect(run(`data: ${long}\n\n`, 65536)).rejects.toThrow("Server-sent event line longer than 1048576 characters");
    const half = "x".repeat(600_000);
    await expect(run(`event: note\ndata: ${half}\ndata: ${half}\n\n`, 65536)).rejects.toThrow(
      "Server-sent event data longer than 1048576 characters",
    );
  });
});

describe("flat client streams (runtime)", () => {
  it("decodes typed events and untyped messages", async () => {
    const { ChatClient } = await loadFlat();
    const fetch = vi.fn(async () => stream(body(WIRE, 3)));
    const api = new ChatClient({ baseUrl: "http://x", fetch });
    expect(await collect(api.watch({ room: "a" }))).toEqual(EXPECTED);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://x/feed?room=a");
    expect(new Headers(init.headers).get("accept")).toBe("text/event-stream");
    const raw = vi.fn(async () => stream(body("id: 3\ndata: x\n\n", 2)));
    expect(await collect(new ChatClient({ baseUrl: "http://x", fetch: raw }).raw())).toEqual([{ data: "x", id: "3" }]);
  });

  it("throws ApiError for a non-2xx response and passes the abort signal to fetch", async () => {
    const { ChatClient, ApiError } = await loadFlat();
    const failing = vi.fn(async () => new Response(JSON.stringify({ code: "nope" }), { status: 500 }));
    const error = await collect(new ChatClient({ baseUrl: "http://x", fetch: failing }).watch({ room: "a" })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as { status: number }).status).toBe(500);

    const cancel = vi.fn();
    const fetch = vi.fn(async (_url: string, init: RequestInit) => stream(endless(init.signal, cancel)));
    const controller = new AbortController();
    const api = new ChatClient({ baseUrl: "http://x", fetch });
    const run = (async () => {
      for await (const _ of api.watch({ room: "a" }, { signal: controller.signal })) controller.abort(new Error("stop"));
    })();
    await expect(run).rejects.toThrow("stop");
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBe(controller.signal);
  });
});

describe("streams with @useAuth credentials (runtime)", () => {
  const secureSpec = `
    @service @useAuth(BearerAuth) namespace Secure;
    model Key is ApiKeyAuth<ApiKeyLocation.query, "api_key">;
    @events union Ticks { @Events.contentType("text/plain") tick: int32 }
    @route("/feed") interface Feed {
      @get watch(@query room: string): SSEStream<Ticks>;
      @get @route("/keyed") @useAuth(Key) keyed(): SSEStream<Ticks>;
    }
  `;
  const TICKS = "event: tick\ndata: 1\n\n";
  const auth = { BearerAuth: async () => "tok", Key: () => "k" };

  const expectAuthenticated = (fetch: ReturnType<typeof vi.fn>) => {
    const [[bearerUrl, bearerInit], [keyUrl, keyInit]] = fetch.mock.calls as unknown as [URL | string, RequestInit][];
    expect(String(bearerUrl)).toBe("http://x/feed?room=a");
    expect(new Headers(bearerInit.headers).get("authorization")).toBe("Bearer tok");
    expect(new Headers(bearerInit.headers).get("accept")).toBe("text/event-stream");
    expect(String(keyUrl)).toBe("http://x/feed/keyed?api_key=k");
    expect(new Headers(keyInit.headers).get("authorization")).toBeNull();
    expect(new Headers(keyInit.headers).get("accept")).toBe("text/event-stream");
  };

  it("sends the operation's credentials with grouped stream requests", async () => {
    const { outputs } = await sseNextjs({ features: { "react-query": false, "server-actions": false } }).compile(secureSpec);
    const { createSecureClient } = await import(pathToFileURL(join(await write("grouped-auth", outputs), "client/index.ts")).href);
    const fetch = vi.fn(async () => stream(body(TICKS, 4)));
    const api = createSecureClient({ baseUrl: "http://x", fetch, auth });
    expect(await collect(api.feed.watch({ room: "a" }))).toEqual([{ event: "tick", data: 1 }]);
    expect(await collect(api.feed.keyed())).toEqual([{ event: "tick", data: 1 }]);
    expectAuthenticated(fetch);
  });

  it("sends the operation's credentials with flat stream requests", async () => {
    const { outputs } = await sseNextjs({ "client-style": "flat" }, { layout: "single-file" }).compile(secureSpec);
    const { SecureClient } = await import(pathToFileURL(join(await write("flat-auth", outputs), "client.ts")).href);
    const fetch = vi.fn(async () => stream(body(TICKS, 4)));
    const api = new SecureClient({ baseUrl: "http://x", fetch, auth });
    expect(await collect(api.watch({ room: "a" }))).toEqual([{ event: "tick", data: 1 }]);
    expect(await collect(api.keyed())).toEqual([{ event: "tick", data: 1 }]);
    expectAuthenticated(fetch);
  });
});
