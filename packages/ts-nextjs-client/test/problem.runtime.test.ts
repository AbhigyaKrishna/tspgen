import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { nextjs } from "./tester.js";

const spec = `
  @service namespace Shop;
  model Item { id: string }
  @error model Oops { @statusCode _: 400; code: string; message: string }
  @route("/items") interface Items {
    @get @route("/{id}") read(@path id: string): Item | Oops;
  }
`;

const dir = mkdtempSync(join(resolve(import.meta.dirname, ".."), ".tmp-run-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function load(style: string, options: Record<string, unknown>, entry: string): Promise<any> {
  const { outputs } = await nextjs(options).compile(spec);
  for (const [path, content] of Object.entries(outputs)) {
    mkdirSync(dirname(join(dir, style, path)), { recursive: true });
    writeFileSync(join(dir, style, path), content);
  }
  return import(pathToFileURL(join(dir, style, entry)).href);
}

const respond = (status: number, body: unknown, contentType: string) => async () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": contentType } });

const PROBLEM = { type: "about:blank", title: "Bad Request", status: 400, detail: "Malformed request body at path $.id" };

describe("problem+json error responses (runtime)", () => {
  it("grouped: raise HttpError with the problem's detail, never the declared error model", async () => {
    const client = await load("grouped", { features: { "react-query": false, "server-actions": false } }, "client/index.ts");
    const { HttpError, OopsError } = await import(pathToFileURL(join(dir, "grouped", "api/errors.ts")).href);
    const call = (fetch: typeof globalThis.fetch) =>
      client.createShopClient({ baseUrl: "http://x", fetch }).items.read({ id: "1" }).catch((e: unknown) => e);

    const problem = await call(respond(400, PROBLEM, "application/problem+json; charset=utf-8"));
    expect(problem).toBeInstanceOf(HttpError);
    expect(problem).not.toBeInstanceOf(OopsError);
    expect(problem.status).toBe(400);
    expect(problem.message).toBe(PROBLEM.detail);
    expect(problem.body).toEqual(PROBLEM);

    const titled = await call(respond(500, { title: "Internal Server Error", status: 500 }, "application/problem+json"));
    expect(titled.message).toBe("Internal Server Error");

    const typed = await call(respond(400, { code: "bad", message: "no" }, "application/json"));
    expect(typed).toBeInstanceOf(OopsError);
    expect(typed.error).toEqual({ code: "bad", message: "no" });

    const plain = await call(respond(503, { detail: "not a problem" }, "application/json"));
    expect(plain).toBeInstanceOf(HttpError);
    expect(plain.message).toBe("HTTP 503");
  });

  it("flat: raise the error class with the problem kept apart from the error model", async () => {
    const mod = await load("flat", { "client-style": "flat", "error-model": "Oops", features: { "react-query": false } }, "client.ts");
    const call = (fetch: typeof globalThis.fetch) =>
      new mod.ShopClient({ baseUrl: "http://x", fetch }).read("1").catch((e: unknown) => e);

    const problem = await call(respond(400, PROBLEM, "application/problem+json"));
    expect(problem).toBeInstanceOf(mod.ShopError);
    expect(problem.status).toBe(400);
    expect(problem.message).toBe(PROBLEM.detail);
    expect(problem.body).toBeUndefined();
    expect(problem.problem).toEqual(PROBLEM);

    const typed = await call(respond(400, { code: "bad", message: "no" }, "application/json"));
    expect(typed.message).toBe("no");
    expect(typed.body).toEqual({ code: "bad", message: "no" });
    expect(typed.problem).toBeUndefined();
  });

  it("flat without an error model: the problem is the body too", async () => {
    const mod = await load("flat-untyped", { "client-style": "flat", features: { "react-query": false } }, "client.ts");
    const error = await new mod.ShopClient({ baseUrl: "http://x", fetch: respond(400, PROBLEM, "application/problem+json") })
      .read("1")
      .catch((e: unknown) => e);
    expect(error.message).toBe(PROBLEM.detail);
    expect(error.body).toEqual(PROBLEM);
    expect(error.problem).toEqual(PROBLEM);
  });
});
