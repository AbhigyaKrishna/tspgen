import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLibraryClient as createV1Client } from "../versioned/generated/v1/client";
import { API_VERSION as V1_API_VERSION, BookSchema as V1BookSchema, type Book as V1Book } from "../versioned/generated/v1/models";
import { createLibraryClient as createV2Client } from "../versioned/generated/v2/client";
import {
  API_VERSION as V2_API_VERSION,
  BookSchema as V2BookSchema,
  GenreSchema as V2GenreSchema,
  type Book as V2Book,
  type Page,
} from "../versioned/generated/v2/models";

const v1Dune: V1Book = { id: 1, name: "Dune", genre: "fiction", shelf: "A1", author: "Herbert", pages: 412 };
const v2Dune: V2Book = { id: 1, title: "Dune", genre: "fiction", isbn: "978-0441013593", pages: 412 };

let server: Server;
let url: string;
const requests: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const json = (status: number, body?: unknown) => {
      res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (req.url?.startsWith("/v1/books/1")) return req.method === "DELETE" ? json(204) : json(200, v1Dune);
    if (req.url?.startsWith("/v2/books/1/reviews")) return json(200, [{ stars: 5 }]);
    if (req.url?.startsWith("/v2/books?")) return json(200, { items: [v2Dune], next: "more" } satisfies Page<V2Book>);
    json(404, { message: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

describe("versioned API generated per version", () => {
  it("exposes the version constants", () => {
    expect(V1_API_VERSION).toBe("2024-01-01");
    expect(V2_API_VERSION).toBe("2024-06-01");
  });

  it("validates each version's shape", () => {
    expect(V1BookSchema.parse(v1Dune)).toEqual(v1Dune);
    expect(V1BookSchema.safeParse(v2Dune).success).toBe(false);
    expect(V2BookSchema.parse(v2Dune)).toEqual(v2Dune);
    expect(V2GenreSchema.parse("poetry")).toBe("poetry");
  });

  it("v1 client calls v1 operations", async () => {
    const api = createV1Client({ baseUrl: `${url}/v1` });
    expect(await api.books.get({ id: 1 })).toEqual(v1Dune);
    await api.books.remove({ id: 1 });
    expect(requests).toContain("DELETE /v1/books/1");
  });

  it("v2 client calls v2 operations with v2 parameters", async () => {
    const api = createV2Client({ baseUrl: `${url}/v2` });
    expect(await api.books.list({ genre: "poetry", limit: 1 })).toEqual({ items: [v2Dune], next: "more" });
    expect(requests).toContain("GET /v2/books?limit=1&genre=poetry");
    expect(await api.books.reviews({ id: 1 })).toEqual([{ stars: 5 }]);
  });
});
