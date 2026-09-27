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

async function readBytes(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Parses a multipart/form-data request with the platform's FormData parser (fails without a boundary). */
async function readForm(req: IncomingMessage): Promise<FormData> {
  const body = await readBytes(req);
  return new Response(new Uint8Array(body), { headers: { "content-type": req.headers["content-type"] ?? "" } }).formData();
}

async function text(value: FormDataEntryValue | null): Promise<string | undefined> {
  if (value === null) return undefined;
  return typeof value === "string" ? value : value.text();
}

/** `<part>:<filename>:<content type>:<text>` for every file of a part, like the Kotlin e2e service. */
async function describeFiles(form: FormData, name: string): Promise<string[]> {
  return Promise.all(form.getAll(name).map(async (f) => (typeof f === "string" ? `${name}:::${f}` : `${name}:${f.name}:${f.type}:${await f.text()}`)));
}

/** The pet feed as written: CRLF, CR and LF line ends, a comment, retry, an unknown event and one after the end. */
const FEED = [
  ": feed start\r\nretry: 1000\r\n\r\n",
  'event: added\r\ndata: {"id":1,"name":"Rex","species":"dog","born_at":"2020-01-01T00:00:00Z"}\r\n\r\n',
  "event: unknown\ndata: skipped\n\n",
  "event: note\rdata: line one\rdata: line two\r\r",
  "event: count\ndata: 3\n\n",
  'event: seen\ndata: "2026-09-27T10:00:00.123Z"\n\n',
  "data: [done]\n\n",
  "event: count\ndata: 99\n\n",
];

/** Streams the feed a few bytes at a time (so lines and UTF-8 characters are split across chunks). */
async function streamFeed(res: ServerResponse): Promise<void> {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  const bytes = Buffer.from(FEED.join(""));
  for (let i = 0; i < bytes.length; i += 7) {
    res.write(bytes.subarray(i, i + 7));
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  res.end();
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
    if (url.pathname.startsWith("/uploads/") && req.method === "POST") {
      const form = await readForm(req);
      const rating = await text(form.get("rating"));
      return send(res, 200, {
        caption: await text(form.get("caption")),
        ...(rating === undefined ? {} : { rating: Number(rating) }),
        petName: (JSON.parse((await text(form.get("pet"))) ?? "{}") as Json).name,
        files: [...(await describeFiles(form, "photo")), ...(await describeFiles(form, "extras"))],
      });
    }
    if (url.pathname.startsWith("/uploads/file") && req.method === "PUT") {
      const body = await readBytes(req);
      return send(res, 200, { contentType: req.headers["content-type"], text: body.toString("utf8") });
    }
    if (url.pathname === "/secure/secret") {
      return req.headers.authorization === "Bearer secret" ? send(res, 200, { message: "secret" }) : send(res, 401);
    }
    if (url.pathname === "/secure/key") {
      return url.searchParams.get("api_key") === "k" ? send(res, 200, { message: `key ${url.searchParams.get("q")}` }) : send(res, 401);
    }
    if (url.pathname === "/secure/public") return send(res, 200, { message: req.headers.authorization ?? "anonymous" });
    if (url.pathname === "/feed" && req.method === "GET") {
      const fail = url.searchParams.get("fail");
      if (fail === "404") return send(res, 404, { message: "no feed" });
      if (fail === "400") return send(res, 400, { code: "bad_feed", message: "bad feed" });
      if (url.searchParams.get("endless") === "true") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        let n = 0;
        const timer = setInterval(() => res.write(`event: count\ndata: ${n++}\n\n`), 5);
        res.on("close", () => {
          clearInterval(timer);
          requests.push("closed /feed");
        });
        return;
      }
      return streamFeed(res);
    }
    if (url.pathname === "/feed/plugin" && req.method === "POST") {
      const filter = await readJson(req);
      if (filter.species === "parrot") return send(res, 404, { message: "no birds" });
      return streamFeed(res);
    }
    if (url.pathname === "/feed/raw" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const count = Number(url.searchParams.get("count"));
      for (let i = 0; i < count; i++) res.write(`${i === 1 ? "event: custom\n" : ""}id: ${i}\ndata: message ${i}\n\n`);
      return res.end();
    }
    send(res, 404, { message: "no route" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, server, requests };
}
