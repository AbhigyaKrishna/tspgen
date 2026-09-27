import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { nextjs, sseNextjs } from "./tester.js";
import { typecheck } from "./typecheck.js";

const spec = `
  @service namespace Shop;
  model Meeting { title: string; at: utcDateTime }
  @error model Problem { at: utcDateTime; message: string }
  @route("/meetings") interface Meetings {
    @get list(@query after?: utcDateTime, @query days?: utcDateTime[]): Meeting[];
    @post create(@body meeting: Meeting): Meeting;
    @get @route("/{day}") byDay(@path day: utcDateTime): Meeting[];
    @delete @route("/{day}") remove(@path day: utcDateTime): void;
  }
`;

const flat = { "client-style": "flat", "error-model": "Problem", features: { validate: true, "react-query": false } };
const dates = { features: { zod: true }, "date-type": "date", layout: "single-file" };
const AT = "2026-09-27T10:00:00.000Z";

const dir = mkdtempSync(join(resolve(import.meta.dirname, ".."), ".tmp-run-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(sub: string, outputs: Record<string, string>): string {
  for (const [path, content] of Object.entries(outputs)) {
    mkdirSync(dirname(join(dir, sub, path)), { recursive: true });
    writeFileSync(join(dir, sub, path), content);
  }
  return join(dir, sub);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("flat client with date-type: date", () => {
  it("decodes results, encodes Date parameters and validates by encoding", async () => {
    const { outputs } = await nextjs(flat, dates).compile(spec);
    const client = outputs["client.ts"];
    expect(client).toContain("    z.encode(z.object({ after: dateTimeCodec.optional(), days: z.array(dateTimeCodec).optional() }), query);");
    expect(client).toContain("    return z.array(z.lazy(() => MeetingSchema)).parse(await this.send(\"GET\", `/meetings${toQuery(query)}`, undefined, init));");
    expect(client).toContain("    z.encode(z.lazy(() => MeetingSchema), withoutUndefined(meeting) as Meeting);");
    expect(client).toContain("`/meetings/${encodeURIComponent(day.toISOString())}`");
    expect(client).toContain(
      "  return new ApiError(response.status, isErrorBody(body) ? (() => { const r = ProblemSchema.safeParse(body); return r.success ? r.data : body; })() : undefined);",
    );
    expect(client).toContain(`/** A query or form value as sent: dates as ISO-8601 strings. */
function toText(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}`);
    expect(client).toContain("    if (!Array.isArray(value)) search.append(key, toText(value));");
    expect(typecheck(outputs)).toBe("");
  });

  it("sends Date multipart text parts as ISO strings", async () => {
    const { outputs } = await nextjs({ "client-style": "flat", features: { "react-query": false } }, dates).compile(`
      @service namespace Shop;
      model Form { at: HttpPart<utcDateTime> }
      @route("/forms") op upload(@header contentType: "multipart/form-data", @multipartBody body: Form): void;
    `);
    expect(outputs["client.ts"]).toContain("form.append(part.name, toText(item));");
  });

  it("round-trips Dates at runtime", async () => {
    const { outputs } = await nextjs(flat, dates).compile(spec);
    const { ShopClient, ApiError } = await import(pathToFileURL(join(write("flat", outputs), "client.ts")).href);
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/conflict")) return json({ at: AT, message: "taken" }, 409);
      return init.method === "POST" ? json(JSON.parse(String(init.body))) : json([{ title: "a", at: AT }]);
    });
    const api = new ShopClient({ baseUrl: "http://x", fetch });
    const at = new Date(AT);

    const [listed] = await api.list({ after: at, days: [at, at] });
    expect(listed.at).toEqual(at);
    const listUrl = new URL(fetch.mock.calls[0][0] as string);
    expect(listUrl.searchParams.get("after")).toBe(AT);
    expect(listUrl.searchParams.get("days")).toBe(`${AT},${AT}`);

    const created = await api.create({ title: "a", at });
    expect(JSON.parse(String((fetch.mock.calls[1][1] as RequestInit).body))).toEqual({ title: "a", at: AT });
    expect(created.at).toEqual(at);
    await expect(api.create({ title: "a", at: new Date("nope") })).rejects.toMatchObject({ name: "ZodError" });
    expect(fetch).toHaveBeenCalledTimes(2);

    await api.byDay(at);
    expect(new URL(fetch.mock.calls[2][0] as string).pathname).toBe(`/meetings/${encodeURIComponent(AT)}`);

    const conflict = vi.fn(async () => json({ at: AT, message: "taken" }, 409));
    const error = await new ShopClient({ baseUrl: "http://x", fetch: conflict }).remove(at).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as { body: { at: Date } }).body.at).toEqual(at);
  });

  it("keeps the raw error body when it fails to decode, instead of throwing or becoming undefined", async () => {
    const { outputs } = await nextjs(flat, dates).compile(spec);
    const { ShopClient, ApiError } = await import(pathToFileURL(join(write("flat-bad-error", outputs), "client.ts")).href);
    const bad = vi.fn(async () => json({ at: "not-a-date", message: "taken" }, 409));
    const error = await new ShopClient({ baseUrl: "http://x", fetch: bad }).remove(new Date(AT)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as { body: unknown }).body).toEqual({ at: "not-a-date", message: "taken" });
  });

  it("a model literally named Date compiles under the flat client too, in both layouts", async () => {
    const dateModelSpec = `
      @service namespace Shop;
      model Date { x: int32 }
      model M { at: utcDateTime; d: Date }
      @route("/m") interface Ms { @get get(@query at: utcDateTime): M; }
    `;
    const flatOptions = { "client-style": "flat", features: { validate: true, "react-query": false } };
    for (const layout of ["per-type", "single-file"] as const) {
      const { outputs } = await nextjs(flatOptions, { ...dates, layout }).compile(dateModelSpec);
      expect(typecheck(outputs)).toBe("");
    }
  });

  it("decodes Date payloads of server-sent events", async () => {
    const { outputs } = await sseNextjs({ "client-style": "flat", features: { "react-query": false } }, dates).compile(`
      @service namespace Feed;
      model Tick { at: utcDateTime }
      @events union Ticks { tick: Tick }
      @route("/ticks") op ticks(): SSEStream<Ticks>;
    `);
    expect(outputs["client.ts"]).toContain(
      '    for await (const event of decodeEvents(response.body, [{ event: "tick", data: "json" }])) yield z.lazy(() => TicksSchema).parse(event);',
    );
    const { FeedClient } = await import(pathToFileURL(join(write("sse", outputs), "client.ts")).href);
    const fetch = vi.fn(async () => new Response(`event: tick\ndata: {"at":"${AT}"}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    const events = [];
    for await (const event of new FeedClient({ baseUrl: "http://x", fetch }).ticks()) events.push(event);
    expect(events).toEqual([{ event: "tick", data: { at: new Date(AT) } }]);
  });
});
