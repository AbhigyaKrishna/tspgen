import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { nextjs } from "./tester.js";

const spec = `
  using TspGen;
  @service namespace Shop;
  model Node { id: string; name: string }
  model CreateNodeRequest { @maxLength(8) name: string; note?: string }
  @@meta(Shop.CreateNodeRequest.name, "*", #{ notBlank: true });
  @route("/nodes") interface Nodes {
    @post createNode(@body request: CreateNodeRequest): Node;
    @get listNodes(@query @maxValue(100) limit?: int32): Node[];
  }
`;

const dir = mkdtempSync(join(resolve(import.meta.dirname, ".."), ".tmp-run-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function load() {
  const { outputs } = await nextjs({ "client-style": "flat", features: { validate: true } }, { features: { zod: true }, layout: "single-file" }).compile(spec);
  for (const [path, content] of Object.entries(outputs)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return import(pathToFileURL(join(dir, "client.ts")).href);
}

describe("flat client validate (runtime)", () => {
  it("rejects invalid input without calling fetch and sends valid input unchanged", async () => {
    const { ShopClient } = await load();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: "1", name: "db" }), { status: 200 }));
    const api = new ShopClient({ baseUrl: "http://x", fetch });

    await expect(api.createNode({ name: "   " })).rejects.toMatchObject({ name: "ZodError" });
    await expect(api.createNode({ name: "way-too-long" })).rejects.toMatchObject({ name: "ZodError" });
    await expect(api.listNodes({ limit: 101 })).rejects.toMatchObject({ name: "ZodError" });
    expect(fetch).not.toHaveBeenCalled();

    // undefined-valued keys are ignored by validation (JSON drops them) and not sent
    await expect(api.createNode({ name: "db", note: undefined })).resolves.toEqual({ id: "1", name: "db" });
    expect(fetch).toHaveBeenCalledOnce();
    const [, first] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(first.body))).toEqual({ name: "db" });
    fetch.mockClear();

    const request = { name: "db", extra: 1 };
    await expect(api.createNode(request)).resolves.toEqual({ id: "1", name: "db" });
    expect(fetch).toHaveBeenCalledOnce();
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual(request);
  });
});
