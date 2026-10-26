import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotFoundError } from "../generated/shared/api";
import {
  createPetStoreClient,
  type PetStoreApiClient,
} from "../generated/shared/client";
import { PetSchema, type Pet } from "../generated/shared/models";

const pet: Pet = {
  id: 42,
  name: "Milo",
  species: "parrot",
  born_at: "2026-01-02T03:04:05Z",
  price: "1.25",
  note: null,
};

function send(response: ServerResponse, status: number, body?: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
}

async function serve(
  request: IncomingMessage,
  response: ServerResponse,
  pets: Map<number, Pet>,
): Promise<void> {
  const url = new URL(request.url!, "http://localhost");
  if (url.pathname === "/pets" && request.method === "POST") {
    const value = PetSchema.parse(await readBody(request));
    pets.set(value.id, value);
    return send(response, 201, value);
  }
  if (url.pathname === "/pets") {
    const items = [...pets.values()];
    const limit = url.searchParams.get("limit");
    return send(response, 200, {
      items: limit === null ? items : items.slice(0, Number(limit)),
      total: items.length,
    });
  }
  if (url.pathname.startsWith("/pets/names/")) {
    return send(response, 200, {
      name: decodeURIComponent(url.pathname.slice("/pets/names/".length)),
      ...(url.searchParams.has("active")
        ? { active: url.searchParams.get("active") === "true" }
        : {}),
      ...(request.headers["x-trace"] !== undefined
        ? { trace: request.headers["x-trace"] }
        : {}),
    });
  }
  if (request.method === "POST")
    return send(response, 200, await readBody(request));
  const id = Number(url.pathname.slice("/pets/".length));
  if (!pets.has(id)) return send(response, 404, { message: "pet not found" });
  if (request.method === "DELETE") {
    pets.delete(id);
    return send(response, 204);
  }
  send(response, 200, pets.get(id));
}

describe("shared TypeSpec feature contract", () => {
  let server: Server;
  let api: PetStoreApiClient;
  const requests: string[] = [];

  beforeAll(async () => {
    const pets = new Map<number, Pet>();
    server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      serve(request, response, pets).catch((error: unknown) =>
        send(response, 500, { message: String(error) }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    api = createPetStoreClient({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    });
  });

  afterAll(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );

  it("round-trips models, generic pages, and typed errors", async () => {
    expect(await api.pets.create({ pet })).toEqual(pet);
    expect(await api.pets.read({ id: pet.id })).toEqual(pet);
    expect(await api.pets.list({ limit: 1 })).toEqual({
      items: [pet],
      total: 1,
    });
    await api.pets.remove({ id: pet.id });
    await expect(api.pets.read({ id: pet.id })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await api.pets.list()).toEqual({ items: [], total: 0 });
  });

  it("binds escaped paths, optional query and header values, and collection bodies", async () => {
    for (const name of ["a/b", "雪 ?#%", "literal%2Fslash"]) {
      expect(await api.pets.lookup({ name, active: false, trace: "" })).toEqual(
        { name, active: false, trace: "" },
      );
    }
    expect(await api.pets.lookup({ name: "absent" })).toEqual({
      name: "absent",
    });
    for (const labels of [["cat", "雪", ""], []]) {
      expect(await api.pets.labels({ labels })).toEqual(labels);
    }
  });

  it("round-trips discriminated variants and scalar union parameters", async () => {
    expect(
      await api.toys.echo({ toy: { kind: "ball", label: "red", bounce: 3 } }),
    ).toEqual({ kind: "ball", label: "red", bounce: 3 });
    expect(
      await api.toys.echo({
        toy: { kind: "kite", label: "blue", length: 2.5 },
      }),
    ).toEqual({ kind: "kite", label: "blue", length: 2.5 });
    for (const sort of ["newest", 7] as const) {
      expect(await api.tagging.echo({ tags: { pet: "Milo" }, sort })).toEqual({
        pet: "Milo",
      });
      expect(requests).toContain(`POST /tags?sort=${sort}`);
    }
  });

  it("validates shared constraints, enums, timestamps, decimals, and required nullability", () => {
    expect(PetSchema.parse(pet)).toEqual(pet);
    for (const invalid of [
      { id: 0 },
      { name: "x" },
      { species: "dragon" },
      { born_at: "yesterday" },
      { price: 1.25 },
      { note: undefined },
    ]) {
      expect(PetSchema.safeParse({ ...pet, ...invalid }).success).toBe(false);
    }
  });
});
