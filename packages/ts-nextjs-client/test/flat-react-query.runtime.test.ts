import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { QueryClient } from "@tanstack/react-query";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextjs } from "./tester.js";

// hooks.ts runs outside React here: the context hands out the current client and the TanStack hooks return
// their options, so a hook's mutationFn / query options can be called directly.
const current = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useContext: () => current.client }));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: (options: unknown) => options,
  useMutation: (options: unknown) => options,
}));

const spec = `
  @service namespace Shop;
  model Node { id: string; name: string }
  model CreateNodeRequest { name: string }
  model Patch { name?: string }
  @route("/nodes") interface Nodes {
    @get list(@query limit?: int32): Node[];
    @get @route("/{id}") read(@path id: string): Node;
    @put @route("/{id}") update(@path id: string, @body body: CreateNodeRequest, @query dryRun?: boolean): Node;
    @patch @route("/{id}") patch(@path id: string, @body patch?: Patch, @query reason: string): Node;
    @post @route("/refresh") refresh(): void;
    @head @route("/{id}") exists(@path id: string): void;
  }
  @route("/files") interface Files {
    @put @route("/{id}") upload(@path id: string, @bodyRoot file: File<"image/png">): void;
  }
`;

const dir = mkdtempSync(join(resolve(import.meta.dirname, ".."), ".tmp-run-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function write(sub: string, outputs: Record<string, string>): Promise<(file: string) => Promise<any>> {
  for (const [path, content] of Object.entries(outputs)) {
    mkdirSync(dirname(join(dir, sub, path)), { recursive: true });
    writeFileSync(join(dir, sub, path), content);
  }
  return (file) => import(pathToFileURL(join(dir, sub, file)).href);
}

let loaded: Promise<{ client: any; queries: any; hooks: any }> | undefined;
function load() {
  loaded ??= (async () => {
    const { outputs } = await nextjs({ "client-style": "flat", "react-query": true }, { layout: "single-file" }).compile(spec);
    const importFile = await write("flat", outputs);
    return { client: await importFile("client.ts"), queries: await importFile("queries.ts"), hooks: await importFile("hooks.ts") };
  })();
  return loaded;
}

type Call = [string, RequestInit];
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const node = { id: "a b", name: "db" };

beforeEach(() => {
  current.client = undefined;
});

describe("flat client react-query (runtime)", () => {
  it("passes the query's AbortSignal to fetch and the method's init signal through", async () => {
    const { client, queries } = await load();
    const fetch = vi.fn(async () => json(node));
    const api = new client.ShopClient({ baseUrl: "http://x", fetch });
    const queryClient = new QueryClient();

    await expect(queryClient.fetchQuery(queries.shopQueries.nodes.read(api, { id: "a b" }))).resolves.toEqual(node);
    const [url, init] = fetch.mock.calls[0] as unknown as Call;
    expect(url).toBe("http://x/nodes/a%20b");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(queryClient.getQueryData(["Shop", "nodes", "read", { id: "a b" }])).toEqual(node);

    const controller = new AbortController();
    await api.list({ limit: 2 }, { signal: controller.signal });
    await api.list();
    const [[listUrl, withSignal], [, without]] = (fetch.mock.calls as unknown as Call[]).slice(1);
    expect(listUrl).toBe("http://x/nodes?limit=2");
    expect(withSignal.signal).toBe(controller.signal);
    expect("signal" in without).toBe(false);
  });

  it("aborts the fetch when the query is cancelled", async () => {
    const { client, queries } = await load();
    let seen: AbortSignal | undefined;
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init.signal ?? undefined;
          seen?.addEventListener("abort", () => reject(seen?.reason));
        }),
    );
    const api = new client.ShopClient({ baseUrl: "http://x", fetch });
    const queryClient = new QueryClient();
    const pending = queryClient.fetchQuery(queries.shopQueries.nodes.list(api));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await queryClient.cancelQueries({ queryKey: queries.shopKeys.nodes.all });
    await expect(pending).rejects.toThrow("CancelledError");
    expect(seen?.aborted).toBe(true);
  });

  it("maps mutation variables to the method's positional arguments", async () => {
    const { client, hooks } = await load();
    const fetch = vi.fn(async (_url: string, init: RequestInit) => (init.method === "PUT" || init.method === "PATCH" ? json(node) : new Response(null, { status: 204 })));
    current.client = new client.ShopClient({ baseUrl: "http://x", fetch });

    const update = hooks.useUpdateMutation();
    await expect(update.mutationFn({ id: "n1", body: { name: "db" }, query: { dryRun: true } })).resolves.toEqual(node);
    await hooks.usePatchMutation().mutationFn({ id: "n2", query: { reason: "fix" } });
    await hooks.usePatchMutation().mutationFn({ id: "n3", body: { name: "x" }, query: { reason: "r" } });
    await hooks.useRefreshMutation().mutationFn();
    const file = new Blob(["png"], { type: "image/png" });
    await hooks.useUploadMutation().mutationFn({ id: "f1", body: file });

    const calls = (fetch.mock.calls as unknown as Call[]).map(([url, init]) => [init.method, url, init.body]);
    expect(calls).toEqual([
      ["PUT", "http://x/nodes/n1?dryRun=true", JSON.stringify({ name: "db" })],
      ["PATCH", "http://x/nodes/n2?reason=fix", undefined],
      ["PATCH", "http://x/nodes/n3?reason=r", JSON.stringify({ name: "x" })],
      ["POST", "http://x/nodes/refresh", undefined],
      ["PUT", "http://x/files/f1", file],
    ]);
  });

  it("builds query hooks from the query options and throws without a provider", async () => {
    const { client, hooks, queries } = await load();
    expect(() => hooks.useReadQuery({ id: "1" })).toThrow("ShopClientProvider is missing");
    current.client = new client.ShopClient({ baseUrl: "http://x", fetch: vi.fn() });
    const options = hooks.useReadQuery({ id: "1" }, { enabled: false });
    expect(options.queryKey).toEqual(queries.shopKeys.nodes.read({ id: "1" }));
    expect(options.enabled).toBe(false);
    expect(hooks.useListQuery().queryKey).toEqual(["Shop", "nodes", "list", {}]);
  });

  it("resolves a void HEAD query to null", async () => {
    const { client, queries } = await load();
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const api = new client.ShopClient({ baseUrl: "http://x", fetch });
    await expect(new QueryClient().fetchQuery(queries.shopQueries.nodes.exists(api, { id: "1" }))).resolves.toBeNull();
    const [url, init] = fetch.mock.calls[0] as unknown as Call;
    expect([init.method, url]).toEqual(["HEAD", "http://x/nodes/1"]);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("grouped client react-query (runtime)", () => {
  it("resolves a void HEAD query to null", async () => {
    const { outputs } = await nextjs({ "server-actions": false }, { layout: "single-file" }).compile(spec);
    const importFile = await write("grouped", outputs);
    const { createShopClient } = await importFile("client/index.ts");
    const { shopQueries } = await importFile("client/react-query/queries.ts");
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const api = createShopClient({ baseUrl: "http://x", fetch });
    await expect(new QueryClient().fetchQuery(shopQueries.nodes.exists(api, { id: "1" }))).resolves.toBeNull();
    const [url, init] = fetch.mock.calls[0] as unknown as Call;
    expect([init.method, String(url)]).toEqual(["HEAD", "http://x/nodes/1"]);
  });
});
