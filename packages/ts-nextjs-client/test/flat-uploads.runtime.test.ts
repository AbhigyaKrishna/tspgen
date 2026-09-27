import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { nextjs } from "./tester.js";

const spec = `
  @service namespace Media;
  model Meta { title: string }
  model UploadRequest {
    name: HttpPart<string>;
    count?: HttpPart<int32>;
    meta: HttpPart<Meta>;
    avatar: HttpPart<File>;
    photos?: HttpPart<File<"image/png">>[];
    vendor?: HttpPart<{ @header contentType: "application/vnd.meta+json"; @body body: Meta }>;
  }
  model Receipt { size: int32 }
  @route("/uploads") interface Uploads {
    @post upload(@header contentType: "multipart/form-data", @multipartBody body: UploadRequest): Receipt;
    @put @route("/file") file(@bodyRoot file: File<"image/png">): void;
    @post @route("/meta") meta(@body meta: Meta): Receipt;
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

async function load() {
  const { outputs } = await nextjs({ "client-style": "flat", validate: true }, { zod: true, layout: "single-file" }).compile(spec);
  return import(pathToFileURL(join(await write("flat", outputs), "client.ts")).href);
}

async function loadGrouped() {
  const { outputs } = await nextjs({ "react-query": false, "server-actions": false }, { zod: true }).compile(spec);
  return import(pathToFileURL(join(await write("grouped", outputs), "client/index.ts")).href);
}

const calls = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls as unknown as [string, RequestInit][];
const headersOf = (init: RequestInit) => new Headers(init.headers);

describe("flat client uploads (runtime)", () => {
  it("sends multipart bodies as FormData without a manual content type", async () => {
    const { MediaClient } = await load();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ size: 3 }), { status: 200 }));
    const api = new MediaClient({ baseUrl: "http://x", fetch, headers: { authorization: "t" } });

    const avatar = new File(["abc"], "me.png", { type: "image/png" });
    const photo = new Blob(["p1"], { type: "image/png" });
    await expect(api.upload({ name: "Rex", meta: { title: "t" }, avatar, photos: [photo, photo] })).resolves.toEqual({ size: 3 });

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://x/uploads");
    expect([...headersOf(init)]).toEqual([["authorization", "t"]]);
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect([...form.keys()]).toEqual(["name", "meta", "avatar", "photos", "photos"]);
    expect(form.get("name")).toBe("Rex");
    expect(form.has("count")).toBe(false);
    const meta = form.get("meta") as File;
    expect(meta.type).toBe("application/json");
    expect(JSON.parse(await meta.text())).toEqual({ title: "t" });
    expect((form.get("avatar") as File).name).toBe("me.png");
    expect(await (form.get("avatar") as File).text()).toBe("abc");
    expect((form.getAll("photos") as File[]).map((f) => f.name)).toEqual(["photos", "photos"]);
  });

  it("validates the request object before building the form", async () => {
    const { MediaClient } = await load();
    const fetch = vi.fn();
    const api = new MediaClient({ baseUrl: "http://x", fetch });
    await expect(api.upload({ name: "Rex", meta: { title: "t" }, avatar: "not a blob" })).rejects.toMatchObject({ name: "ZodError" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends file bodies as-is with the blob's type or the declared one", async () => {
    const { MediaClient } = await load();
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const api = new MediaClient({ baseUrl: "http://x", fetch });
    const typed = new Blob(["x"], { type: "image/webp" });
    await api.file(typed);
    await api.file(new Blob(["y"]));
    const [first, second] = calls(fetch);
    expect(first![1].body).toBe(typed);
    expect([...headersOf(first![1])]).toEqual([["content-type", "image/webp"]]);
    expect([...headersOf(second![1])]).toEqual([["content-type", "image/png"]]);
  });

  it("replaces a Content-Type from the client options, in any case", async () => {
    const { MediaClient } = await load();
    for (const name of ["Content-Type", "content-type"]) {
      const fetch = vi.fn(async () => new Response(JSON.stringify({ size: 3 }), { status: 200 }));
      const api = new MediaClient({ baseUrl: "http://x", fetch, headers: { [name]: "application/json", authorization: "t" } });
      await api.upload({ name: "Rex", meta: { title: "t" }, avatar: new Blob(["a"]) });
      await api.file(new Blob(["y"]));
      const [multipart, file] = calls(fetch);
      // No content type for FormData: fetch writes multipart/form-data with its boundary.
      expect(headersOf(multipart![1]).has("content-type")).toBe(false);
      expect(headersOf(multipart![1]).get("authorization")).toBe("t");
      expect(headersOf(file![1]).get("content-type")).toBe("image/png");
    }
  });

  it("replaces a lowercase content-type from the client options for JSON bodies", async () => {
    const { MediaClient } = await load();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ size: 3 }), { status: 200 }));
    const api = new MediaClient({ baseUrl: "http://x", fetch, headers: { "content-type": "text/plain" } });
    await api.meta({ title: "t" });
    const [, init] = calls(fetch)[0]!;
    expect([...headersOf(init)]).toEqual([["content-type", "application/json"]]);
    expect(init.body).toBe(JSON.stringify({ title: "t" }));
  });

  it("types untyped blobs of file parts with the declared content type, keeping file names", async () => {
    const { MediaClient } = await load();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ size: 3 }), { status: 200 }));
    const api = new MediaClient({ baseUrl: "http://x", fetch });
    const avatar = new Blob(["a"]);
    await api.upload({ name: "Rex", meta: { title: "t" }, avatar, photos: [new Blob(["p1"]), new File(["p2"], "two.png"), new Blob(["p3"], { type: "image/gif" })] });
    const form = calls(fetch)[0]![1].body as FormData;
    const photos = form.getAll("photos") as File[];
    expect(photos.map((f) => [f.name, f.type])).toEqual([["photos", "image/png"], ["two.png", "image/png"], ["photos", "image/gif"]]);
    expect(await photos[1]!.text()).toBe("p2");
    // HttpPart<File> declares any content type: left untyped.
    expect((form.get("avatar") as File).type).toBe("");
  });

  it("sends JSON parts with their declared JSON content type", async () => {
    const { MediaClient } = await load();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ size: 3 }), { status: 200 }));
    const api = new MediaClient({ baseUrl: "http://x", fetch });
    await api.upload({ name: "Rex", meta: { title: "t" }, avatar: new Blob(["a"]), vendor: { title: "v" } });
    const form = calls(fetch)[0]![1].body as FormData;
    expect((form.get("meta") as File).type).toBe("application/json");
    expect((form.get("vendor") as File).type).toBe("application/vnd.meta+json");
    expect(JSON.parse(await (form.get("vendor") as File).text())).toEqual({ title: "v" });
  });
});

describe("grouped client uploads (runtime)", () => {
  it("sends JSON parts with their declared JSON content type", async () => {
    const { createMediaClient } = await loadGrouped();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ size: 3 }), { status: 200, headers: { "content-type": "application/json" } }));
    const api = createMediaClient({ baseUrl: "http://x", fetch });
    await api.uploads.upload({ body: { name: "Rex", meta: { title: "t" }, avatar: new Blob(["a"]), vendor: { title: "v" } } });
    const form = calls(fetch)[0]![1].body as FormData;
    expect((form.get("meta") as File).type).toBe("application/json");
    expect((form.get("vendor") as File).type).toBe("application/vnd.meta+json");
    expect(JSON.parse(await (form.get("vendor") as File).text())).toEqual({ title: "v" });
  });

  it("types untyped blobs of file parts with the declared content type, keeping file names", async () => {
    const { createMediaClient } = await loadGrouped();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ size: 3 }), { status: 200, headers: { "content-type": "application/json" } }));
    const api = createMediaClient({ baseUrl: "http://x", fetch, headers: { "Content-Type": "application/json" } });
    await api.uploads.upload({ body: { name: "Rex", meta: { title: "t" }, avatar: new Blob(["a"]), photos: [new Blob(["p1"]), new File(["p2"], "two.png")] } });
    const [, init] = calls(fetch)[0]!;
    expect(headersOf(init).has("content-type")).toBe(false);
    const photos = (init.body as FormData).getAll("photos") as File[];
    expect(photos.map((f) => [f.name, f.type])).toEqual([["photos", "image/png"], ["two.png", "image/png"]]);
  });
});
