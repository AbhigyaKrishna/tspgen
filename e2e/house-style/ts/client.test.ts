import { describe, expect, it } from "vitest";
import { ApiError, NODE_KINDS, ShopClient, type Node } from "./generated";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(respond: (url: string, init: RequestInit | undefined) => Response): { fn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return respond(url, init);
  };
  return { fn, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const node: Node = { id: "n1", kind: "DATABASE", name: "db", createdAt: "2026-01-01T00:00:00Z" };

describe("generated flat client (house style)", () => {
  it("lists with query params, creates with a JSON body and deletes with 204", async () => {
    const { fn, calls } = fakeFetch((_url, init) => {
      if (init?.method === "GET") return json({ items: [node], total: 1, offset: 0, limit: 10 });
      if (init?.method === "POST") return json(node, 201);
      return new Response(null, { status: 204 });
    });
    const api = new ShopClient({ baseUrl: "http://api/", fetch: fn, headers: { authorization: "Bearer t" } });

    const page = await api.listNodes({ kind: "DATABASE", limit: 10 });
    expect(page.items).toEqual([node]);
    expect(calls[0]?.url).toBe("http://api/graph/nodes?kind=DATABASE&limit=10");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer t");

    expect(await api.createNode({ name: "db", kind: "DATABASE" })).toEqual(node);
    expect(calls[1]?.init?.body).toBe(JSON.stringify({ name: "db", kind: "DATABASE" }));
    expect(new Headers(calls[1]?.init?.headers).get("content-type")).toBe("application/json");

    expect(await api.deleteNode("n 1")).toBeUndefined();
    expect(calls[2]?.url).toBe("http://api/graph/nodes/n%201");
  });

  it("throws ApiError carrying the error envelope, with a fallback for non-JSON bodies", async () => {
    const { fn } = fakeFetch((url) =>
      url.endsWith("/missing")
        ? json({ status: 404, code: "NOT_FOUND", message: "Node 'missing' was not found" }, 404)
        : new Response("<html>bad gateway</html>", { status: 502 }),
    );
    const api = new ShopClient({ baseUrl: "http://api", fetch: fn });

    const missing = (await api.readNode("missing").catch((e: unknown) => e)) as ApiError;
    expect(missing).toBeInstanceOf(ApiError);
    expect(missing.isNotFound).toBe(true);
    expect(missing.code).toBe("NOT_FOUND");
    expect(missing.message).toBe("Node 'missing' was not found");

    const broken = (await api.readNode("x").catch((e: unknown) => e)) as ApiError;
    expect(broken.status).toBe(502);
    expect(broken.body).toBeUndefined();
    expect(broken.message).toBe("Request failed with status 502");
  });

  it("exposes enum values as a const tuple", () => {
    expect(NODE_KINDS).toEqual(["DATABASE", "QUEUE"]);
  });
});
