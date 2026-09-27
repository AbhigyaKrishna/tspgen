import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { ApiErrorError, NotFoundError } from "../generated/api";
import { HttpError } from "../generated/api/errors";
import { createPetStoreClient, type PetStoreApiClient } from "../generated/client";
import { petsCreateAction, petsRemoveAction } from "../generated/client/actions/pets";
import type { Pet } from "../generated/models";
import { startStubServer } from "./stub-server";

let server: Server;
let requests: string[];
let api: PetStoreApiClient;

beforeAll(async () => {
  const stub = await startStubServer();
  server = stub.server;
  requests = stub.requests;
  process.env.API_BASE_URL = stub.url;
  api = createPetStoreClient({ baseUrl: stub.url });
});

afterAll(() => {
  server.close();
});

const rex: Pet = { id: 1, name: "Rex", species: "dog", tags: ["good"], born_at: "2020-01-01T00:00:00Z" };

describe("generated Next.js client against a stub server", () => {
  it("round-trips pets with results, headers, query arrays and typed errors", async () => {
    expect(await api.pets.create({ pet: rex })).toEqual({ status: 201, body: rex, headers: { location: "/pets/1" } });
    expect(await api.pets.create({ pet: rex })).toEqual({ status: 200, body: rex });
    expect(await api.pets.get({ petId: 1, trace: "abc" })).toEqual(rex);
    expect(await api.pets.list({ limit: 10, tags: ["good", "calm"], species: "dog" })).toEqual([rex]);
    expect(requests).toContain("GET /pets?limit=10&tags=good&tags=calm&species=dog");

    const missing = await api.pets.get({ petId: 99 }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(NotFoundError);
    expect((missing as NotFoundError).status).toBe(404);
    expect((missing as NotFoundError).error.message).toBe("pet 99 not found");

    const bad = await api.pets.list({ limit: -1 }).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(ApiErrorError);
    expect((bad as ApiErrorError).error.code).toBe("bad_limit");

    await expect(api.pets.remove({ petId: 1 })).resolves.toBeUndefined();
    await expect(api.pets.remove({ petId: 1 })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("handles discriminated unions", async () => {
    await api.toys.add({ toy: { kind: "ball", name: "red", diameter: 3.5 } });
    await api.toys.add({ toy: { kind: "rope", name: "long", length: 2 } });
    expect(await api.toys.list()).toEqual([
      { kind: "ball", name: "red", diameter: 3.5 },
      { kind: "rope", name: "long", length: 2 },
    ]);
  });

  it("validates responses with zod unless disabled", async () => {
    await expect(api.pets.get({ petId: 13 })).rejects.toBeInstanceOf(ZodError);
    const lenient = createPetStoreClient({ baseUrl: process.env.API_BASE_URL!, validate: false });
    expect(await lenient.pets.get({ petId: 13 })).toEqual({ id: 13, species: "dog" });
  });

  it("passes RequestInit options, client-wide init and config headers through to fetch", async () => {
    const seen: RequestInit[] = [];
    const spy = createPetStoreClient({
      baseUrl: process.env.API_BASE_URL!,
      headers: async () => ({ authorization: "Bearer t" }),
      init: { credentials: "include", cache: "no-store" },
      fetch: (input, init) => {
        seen.push(init ?? {});
        return fetch(input, init);
      },
    });
    await spy.pets.list({}, { next: { revalidate: 60, tags: ["pets"] }, cache: "force-cache", keepalive: true });
    const init = seen[0] as RequestInit & { next?: unknown };
    expect(init.next).toEqual({ revalidate: 60, tags: ["pets"] });
    expect(init.cache).toBe("force-cache");
    expect(init.credentials).toBe("include");
    expect(init.keepalive).toBe(true);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer t");
    await spy.pets.list();
    const defaults = seen[1] as RequestInit & { next?: unknown };
    expect(defaults.next).toEqual({ revalidate: 60, tags: ["pets"] });
    expect(defaults.cache).toBe("no-store");
    expect(defaults.credentials).toBe("include");
  });

  it("uploads multipart bodies as FormData and file bodies as-is", async () => {
    const upload = {
      caption: "Rex at the park",
      rating: 5,
      pet: { id: 1, name: "Rex", species: "dog" } as const,
      photo: new File(["png-bytes"], "rex.png", { type: "image/png" }),
      extras: [new Blob(["extra"])],
    };
    const expected = {
      caption: "Rex at the park",
      rating: 5,
      petName: "Rex",
      files: ["photo:rex.png:image/png:png-bytes", "extras:extras:application/octet-stream:extra"],
    };
    expect(await api.uploads.buffered({ body: upload })).toEqual(expected);
    expect(await api.uploads.raw({ body: { ...upload, rating: undefined, extras: undefined } })).toEqual({
      ...expected,
      rating: undefined,
      files: ["photo:rex.png:image/png:png-bytes"],
    });
    expect(await api.uploads.file({ file: new Blob(["hello"], { type: "text/plain" }) })).toEqual({
      contentType: "text/plain",
      text: "hello",
    });
    expect(await api.uploads.fileStream({ file: new Blob(["raw bytes"]) })).toEqual({
      contentType: "application/octet-stream",
      text: "raw bytes",
    });
  });

  it("sends @useAuth credentials from ClientConfig.auth", async () => {
    const secure = createPetStoreClient({
      baseUrl: process.env.API_BASE_URL!,
      headers: { authorization: "Bearer from-headers" },
      auth: { BearerAuth: async () => "secret", PartnerKey: () => "k" },
    });
    // The bearer provider wins over a configured Authorization header.
    expect(await secure.secure.secret()).toEqual({ message: "secret" });
    expect(await secure.secure.key({ q: "x" })).toEqual({ message: "key x" });
    expect(requests).toContain("GET /secure/key?q=x&api_key=k");
    // NoAuth operations get no credentials, only the configured headers.
    expect(await secure.secure.open()).toEqual({ message: "Bearer from-headers" });

    const denied = await api.secure.secret().catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(HttpError);
    expect((denied as HttpError).status).toBe(401);
    const noToken = createPetStoreClient({ baseUrl: process.env.API_BASE_URL!, auth: { BearerAuth: () => undefined } });
    await expect(noToken.secure.secret()).rejects.toMatchObject({ status: 401 });
  });

  it("streams server-sent events as async iterables", async () => {
    const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
      const out: T[] = [];
      for await (const item of iterable) out.push(item);
      return out;
    };
    const feed = [
      { event: "added", data: { id: 1, name: "Rex", species: "dog", born_at: "2020-01-01T00:00:00Z" } },
      { event: "note", data: "line one\nline two" },
      { event: "count", data: 3 },
      { event: "seen", data: "2026-09-27T10:00:00.123Z" },
      { event: "message", data: "[done]" },
    ];
    expect(await collect(api.feed.watch())).toEqual(feed);
    expect(await collect(api.feed.watchPlugin({ filter: {} }))).toEqual(feed);
    expect(await collect(api.feed.raw({ count: 3 }))).toEqual([
      { data: "message 0", id: "0" },
      { data: "message 1", event: "custom", id: "1" },
      { data: "message 2", id: "2" },
    ]);

    const missing = await collect(api.feed.watch({ fail: 404 })).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(NotFoundError);
    expect((missing as NotFoundError).error.message).toBe("no feed");
    await expect(collect(api.feed.watch({ fail: 400 }))).rejects.toBeInstanceOf(ApiErrorError);
    await expect(collect(api.feed.watchPlugin({ filter: { species: "parrot" } }))).rejects.toBeInstanceOf(NotFoundError);

    // Stopping early closes the connection; so does aborting.
    const counts: unknown[] = [];
    for await (const event of api.feed.watch({ endless: true })) {
      counts.push(event);
      if (counts.length === 3) break;
    }
    expect(counts).toEqual([0, 1, 2].map((n) => ({ event: "count", data: n })));
    const controller = new AbortController();
    const aborted = (async () => {
      for await (const _ of api.feed.watch({ endless: true }, { signal: controller.signal })) controller.abort();
    })();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    await expect.poll(() => requests.filter((r) => r === "closed /feed").length).toBe(2);
  });

  it("runs server actions with validation and serializable errors", async () => {
    const created = await petsCreateAction({ pet: { id: 7, name: "Tom", species: "cat" } });
    expect(created).toEqual({
      ok: true,
      data: { status: 201, body: { id: 7, name: "Tom", species: "cat" }, headers: { location: "/pets/7" } },
    });
    const invalid = await petsCreateAction({ pet: { id: 8, species: "cat" } as unknown as Pet });
    expect(invalid).toMatchObject({ ok: false, status: 400 });
    expect(await petsRemoveAction({ petId: 999 })).toEqual({ ok: false, status: 404, error: { message: "pet 999 not found" } });
  });
});
