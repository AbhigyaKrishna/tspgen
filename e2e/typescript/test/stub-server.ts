import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type Json = Record<string, unknown>;

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, body === undefined ? headers : { "content-type": "application/json", ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Json> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw) as Json;
}

/** In-memory pet store matching e2e/kotlin/petstore.tsp. Pet 13 is returned malformed on purpose. */
export async function startStubServer(): Promise<{ url: string; server: Server; requests: string[] }> {
  const pets = new Map<number, Json>();
  const toys: Json[] = [];
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const id = /^\/pets\/(\d+)$/.exec(url.pathname)?.[1];
    if (url.pathname === "/pets" && req.method === "GET") {
      const limit = url.searchParams.get("limit");
      if (limit !== null && Number(limit) < 0) return send(res, 400, { code: "bad_limit", message: "limit must be >= 0" });
      const tags = url.searchParams.getAll("tags");
      const species = url.searchParams.get("species");
      const found = [...pets.values()]
        .filter((p) => tags.length === 0 || ((p.tags as string[] | undefined) ?? []).some((t) => tags.includes(t)))
        .filter((p) => species === null || p.species === species)
        .slice(0, limit === null ? undefined : Number(limit));
      return send(res, 200, found);
    }
    if (url.pathname === "/pets" && req.method === "POST") {
      const pet = await readJson(req);
      if (pets.has(pet.id as number)) return send(res, 200, pet);
      pets.set(pet.id as number, pet);
      return send(res, 201, pet, { location: `/pets/${pet.id}` });
    }
    if (id && req.method === "GET") {
      if (id === "13") return send(res, 200, { id: 13, species: "dog" });
      const pet = pets.get(Number(id));
      return pet ? send(res, 200, pet) : send(res, 404, { message: `pet ${id} not found` });
    }
    if (id && req.method === "DELETE") {
      return pets.delete(Number(id)) ? send(res, 204) : send(res, 404, { message: `pet ${id} not found` });
    }
    if (url.pathname === "/toys" && req.method === "GET") return send(res, 200, toys);
    if (url.pathname === "/toys" && req.method === "POST") {
      toys.push(await readJson(req));
      return send(res, 204);
    }
    send(res, 404, { message: "no route" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, server, requests };
}
