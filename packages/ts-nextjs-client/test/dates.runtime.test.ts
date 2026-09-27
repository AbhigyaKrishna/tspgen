import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { meetingSpec, nextjs, sseNextjs } from "./tester.js";

const dir = mkdtempSync(join(resolve(import.meta.dirname, ".."), ".tmp-run-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(sub: string, outputs: Record<string, string>): string {
  for (const [path, content] of Object.entries(outputs)) {
    mkdirSync(dirname(join(dir, sub, path)), { recursive: true });
    writeFileSync(join(dir, sub, path), content);
  }
  return join(dir, sub);
}

const importFrom = (root: string, file: string) => import(pathToFileURL(join(root, file)).href);
const dates = { features: { zod: true }, "date-type": "date" };
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...init.headers } });
const AT = "2026-09-27T10:00:00.000Z";

async function loadGrouped() {
  const { outputs } = await nextjs({ features: { "react-query": false } }, dates).compile(meetingSpec);
  const root = write("grouped", outputs);
  return {
    ...(await importFrom(root, "client/index.ts")),
    ...(await importFrom(root, "client/actions/meetings.ts")),
    ...(await importFrom(root, "client/actions/server-client.ts")),
    ...(await importFrom(root, "api/index.ts")),
  };
}

describe("grouped client with Date values (runtime)", () => {
  it("decodes responses into Dates even with validate: false", async () => {
    const { createShopClient } = await loadGrouped();
    const fetch = vi.fn(async () => json([{ title: "standup", at: "2026-09-27T10:00:00Z" }]));
    const [meeting] = await createShopClient({ baseUrl: "http://x", fetch, validate: false }).meetings.list();
    expect(meeting.at).toBeInstanceOf(Date);
    expect(meeting.at.toISOString()).toBe(AT);
  });

  it("sends Date query, path, header and body values as ISO strings", async () => {
    const { createShopClient } = await loadGrouped();
    const fetch = vi.fn(async (_url: URL, init: RequestInit) =>
      init.method === "POST"
        ? json(JSON.parse(String(init.body)))
        : json([], { headers: { "last-modified": "2026-09-26T00:00:00Z" } }),
    );
    const api = createShopClient({ baseUrl: "http://x", fetch });
    const at = new Date(AT);
    await api.meetings.list({ after: at, days: [at, at] });
    const [listUrl] = fetch.mock.calls[0] as unknown as [URL];
    expect(listUrl.searchParams.get("after")).toBe(AT);
    expect(listUrl.searchParams.get("days")).toBe(`${AT},${AT}`);

    const created = await api.meetings.create({ meeting: { title: "a", at } });
    const [, createInit] = fetch.mock.calls[1] as unknown as [URL, RequestInit];
    expect(JSON.parse(String(createInit.body))).toEqual({ title: "a", at: AT });
    expect(created.at).toEqual(at);

    const result = await api.meetings.byDay({ day: at, since: at });
    const [dayUrl, dayInit] = fetch.mock.calls[2] as unknown as [URL, RequestInit];
    expect(dayUrl.pathname).toBe(`/meetings/${encodeURIComponent(AT)}`);
    expect(new Headers(dayInit.headers).get("x-since")).toBe(AT);
    expect(result.headers.modified).toEqual(new Date("2026-09-26T00:00:00Z"));
  });

  it("decodes Date fields of typed error bodies", async () => {
    const { createShopClient, ProblemError } = await loadGrouped();
    const fetch = vi.fn(async () => json({ at: AT, message: "taken" }, { status: 409 }));
    const error = await createShopClient({ baseUrl: "http://x", fetch }).meetings.create({ meeting: { title: "a", at: new Date(AT) } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProblemError);
    expect((error as { error: { at: Date } }).error.at).toEqual(new Date(AT));
  });

  it("keeps the raw error body when a codec error body fails to decode, instead of throwing or becoming undefined", async () => {
    const { createShopClient, ProblemError } = await loadGrouped();
    const fetch = vi.fn(async () => json({ at: "not-a-date", message: "taken" }, { status: 409 }));
    const error = await createShopClient({ baseUrl: "http://x", fetch }).meetings.create({ meeting: { title: "a", at: new Date(AT) } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProblemError);
    expect((error as { error: unknown }).error).toEqual({ at: "not-a-date", message: "taken" });
  });

  it("Server Actions accept Date input and reject an invalid Date without calling the API", async () => {
    const { configureShopActions, meetingsCreateAction } = await loadGrouped();
    const fetch = vi.fn(async (_url: URL, init: RequestInit) => json(JSON.parse(String(init.body))));
    configureShopActions({ baseUrl: "http://x", fetch });
    const ok = await meetingsCreateAction({ meeting: { title: "a", at: new Date(AT) } });
    expect(ok).toEqual({ ok: true, data: { title: "a", at: new Date(AT) } });
    const bad = await meetingsCreateAction({ meeting: { title: "a", at: new Date("not a date") } });
    expect(bad).toMatchObject({ ok: false, status: 400 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("Server Actions strip keys unknown to the schema before forwarding Date params", async () => {
    const { configureShopActions, meetingsCreateAction } = await loadGrouped();
    const fetch = vi.fn(async (_url: URL, init: RequestInit) => json(JSON.parse(String(init.body))));
    configureShopActions({ baseUrl: "http://x", fetch });
    await meetingsCreateAction({ meeting: { title: "a", at: new Date(AT), extra: "nope" } as never });
    const [, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ title: "a", at: AT });
  });

  it("decodes Date payloads of server-sent events with validate: false", async () => {
    const { outputs } = await sseNextjs({ features: { "react-query": false, "server-actions": false } }, dates).compile(`
      @service namespace Feed;
      model Tick { at: utcDateTime }
      @events union Ticks { tick: Tick }
      @route("/ticks") op ticks(): SSEStream<Ticks>;
    `);
    const { createFeedClient } = await importFrom(write("sse", outputs), "client/index.ts");
    const fetch = vi.fn(async () => new Response(`event: tick\ndata: {"at":"${AT}"}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    const events = [];
    for await (const event of createFeedClient({ baseUrl: "http://x", fetch, validate: false }).feed.ticks()) events.push(event);
    expect(events).toEqual([{ event: "tick", data: { at: new Date(AT) } }]);
  });
});
