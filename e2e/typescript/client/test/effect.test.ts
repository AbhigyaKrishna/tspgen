import { Effect, Fiber, Schema, Stream } from "effect";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotFoundError } from "../generated/api/errors";
import { createPetStoreEffectClient, EffectClientError, type PetStoreEffectClient } from "../generated/client";
import { createPetFeedEffectClient } from "../generated/flat/effect";
import { PetEffectSchema } from "../generated/models";
import { startStubServer } from "./stub-server";

let server: Server;
let requests: string[];
let api: PetStoreEffectClient;
let url: string;

beforeAll(async () => {
  const stub = await startStubServer();
  server = stub.server;
  requests = stub.requests;
  url = stub.url;
  // Exercise Effect validation independently of the existing Zod response checks.
  api = createPetStoreEffectClient({ baseUrl: url, validate: false });
});

afterAll(() => server.close());

describe("generated Effect client over HTTP", () => {
  it("round-trips models, result unions, headers, queries and void responses lazily", async () => {
    const pet = examplePet();
    const create = api.pets.create({ pet });
    expect(requests).toEqual([]);
    expect(await Effect.runPromise(create)).toEqual({ status: 201, body: pet, headers: { location: "/pets/101" } });
    expect(await Effect.runPromise(create)).toEqual({ status: 200, body: pet });
    expect(await Effect.runPromise(api.pets.get({ petId: 101 }))).toEqual(pet);
    expect(await Effect.runPromise(api.pets.list({ tags: ["effect"], limit: 10 }))).toEqual([pet]);
    expect(await Effect.runPromise(api.pets.remove({ petId: 101 }))).toBeUndefined();
  });

  it("preserves declared HTTP errors and reports malformed responses in the error channel", async () => {
    const missing = await Effect.runPromise(Effect.flip(api.pets.get({ petId: 999 })));
    expect(missing).toBeInstanceOf(NotFoundError);
    expect(missing).toMatchObject({ status: 404, error: { message: "pet 999 not found" } });
    const malformed = await Effect.runPromise(Effect.flip(api.pets.get({ petId: 13 })));
    expect(malformed).toBeInstanceOf(EffectClientError);
    expect(malformed).toMatchObject({ cause: { _tag: "SchemaError" } });
  });

  it("uses the existing authentication and file-upload behavior", async () => {
    const secure = createPetStoreEffectClient({ baseUrl: url, auth: { BearerAuth: () => "secret" } });
    expect(await Effect.runPromise(secure.secure.secret())).toEqual({ message: "secret" });
    expect(await Effect.runPromise(api.uploads.file({ file: new Blob(["hello"], { type: "text/plain" }) }))).toEqual({
      contentType: "text/plain",
      text: "hello",
    });
  });

  it("collects typed SSE Streams and closes HTTP connections on take and interruption", async () => {
    const stream = api.feed.watch({ endless: true });
    expect(await Effect.runPromise(stream.pipe(Stream.take(2), Stream.runCollect))).toEqual([
      { event: "count", data: 0 },
      { event: "count", data: 1 },
    ]);
    await expect.poll(() => requests.filter((r) => r === "closed /feed").length).toBe(1);
    const fiber = Effect.runFork(Stream.runDrain(stream));
    await expect.poll(() => requests.filter((r) => r === "GET /feed?endless=true").length).toBe(2);
    await Effect.runPromise(Fiber.interrupt(fiber));
    await expect.poll(() => requests.filter((r) => r === "closed /feed").length).toBe(2);
  });

  it("supports the flat companion client and standalone schemas", async () => {
    const flat = createPetFeedEffectClient({ baseUrl: url });
    expect(await Effect.runPromise(flat.watch().pipe(Stream.take(1), Stream.runCollect))).toMatchObject([
      { event: "added", data: { id: 1, name: "Rex", species: "dog" } },
    ]);
    expect(await Effect.runPromise(Schema.decodeUnknownEffect(PetEffectSchema)(examplePet()))).toEqual(examplePet());
  });
});

function examplePet() {
  return { id: 101, name: "Rex", species: "dog" as const, tags: ["effect"] };
}
