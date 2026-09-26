import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { ApiErrorError, NotFoundError } from "../generated/api";
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

  it("passes Next.js fetch options and config headers through to fetch", async () => {
    const seen: RequestInit[] = [];
    const spy = createPetStoreClient({
      baseUrl: process.env.API_BASE_URL!,
      headers: async () => ({ authorization: "Bearer t" }),
      fetch: (input, init) => {
        seen.push(init ?? {});
        return fetch(input, init);
      },
    });
    await spy.pets.list({}, { next: { revalidate: 60, tags: ["pets"] }, cache: "force-cache" });
    const init = seen[0] as RequestInit & { next?: unknown };
    expect(init.next).toEqual({ revalidate: 60, tags: ["pets"] });
    expect(init.cache).toBe("force-cache");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer t");
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
