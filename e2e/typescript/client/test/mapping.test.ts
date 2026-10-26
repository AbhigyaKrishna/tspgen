import { describe, expect, it, vi } from "vitest";
import { createLedgerClient } from "../generated/mapping/client";
import { LedgerClient } from "../generated/mapping-flat/client";

/** The JSON the Kotlin mapping e2e asserts: ISO dates, string-encoded int64 (beyond 2^53), decimal strings. */
const WIRE = {
  title: "rent",
  at: "2026-09-27T10:00:00Z",
  sequence: "9007199254740993",
  amount: "12.50",
  reminders: ["2026-09-28T08:00:00Z"],
};
const AT = new Date("2026-09-27T10:00:00Z");
const SENT = { ...WIRE, at: "2026-09-27T10:00:00.000Z", reminders: ["2026-09-28T08:00:00.000Z"] };

function stub() {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
    new Response(init?.method === "POST" ? String(init.body) : JSON.stringify([WIRE]), {
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("date-type: date clients", () => {
  it("grouped: decodes Dates, keeps exact int64 strings, sends ISO strings", async () => {
    const fetch = stub();
    const api = createLedgerClient({ baseUrl: "http://x", fetch });
    const [entry] = await api.entries.list({ after: AT });
    expect(entry.at).toEqual(AT);
    expect(entry.reminders?.[0]).toBeInstanceOf(Date);
    expect(entry.sequence).toBe("9007199254740993");
    expect(entry.amount).toBe("12.50");
    expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get("after")).toBe("2026-09-27T10:00:00.000Z");
    const created = await api.entries.create({ entry });
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual(SENT);
    expect(created).toEqual(entry);
  });

  it("flat: decodes and validates Dates by encoding", async () => {
    const fetch = stub();
    const api = new LedgerClient({ baseUrl: "http://x", fetch });
    const [entry] = await api.list({ after: AT });
    expect(entry.at).toEqual(AT);
    expect(entry.sequence).toBe("9007199254740993");
    await expect(api.create({ ...entry, at: new Date("nope") })).rejects.toMatchObject({ name: "ZodError" });
    expect(await api.create(entry)).toEqual(entry);
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual(SENT);
  });
});

/** Whole-body @encode(string) int64s exactly as the Kotlin server writes them (TopLevelEncodingE2ETest). */
describe("@encode(string) top-level bodies", () => {
  const KOTLIN_WIRE = '["9007199254740993","1"]';
  const ids = () =>
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(init?.method === "POST" ? String(init.body) : KOTLIN_WIRE, { headers: { "content-type": "application/json" } }),
    );

  it("grouped: reads and sends string ids", async () => {
    const fetch = ids();
    const api = createLedgerClient({ baseUrl: "http://x", fetch });
    expect(await api.entries.ids()).toEqual(["9007199254740993", "1"]);
    expect(await api.entries.take({ ids: ["9007199254740993"] })).toEqual(["9007199254740993"]);
    expect(String(fetch.mock.calls[1][1]?.body)).toBe('["9007199254740993"]');
  });

  it("flat: reads and sends string ids", async () => {
    const fetch = ids();
    const api = new LedgerClient({ baseUrl: "http://x", fetch });
    expect(await api.ids()).toEqual(["9007199254740993", "1"]);
    expect(await api.take(["9007199254740993"])).toEqual(["9007199254740993"]);
    expect(String(fetch.mock.calls[1][1]?.body)).toBe('["9007199254740993"]');
  });
});
