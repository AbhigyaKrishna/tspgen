import { describe, expect, it } from "vitest";
import { buildApiIR } from "../../src/index.js";
import { Tester } from "../tester.js";

const spec = `
  @service(#{ title: "Pet Store" })
  @server("https://api.example.com", "prod")
  @useAuth(BearerAuth)
  namespace PetStore;

  model Pet { id: int64; name: string }
  @error model ApiError { code: string }

  @route("/pets") interface Pets {
    /** Get a pet */
    @get get(@path id: int64, @query verbose?: boolean, @header("x-trace") trace?: string): Pet | ApiError;
    @post create(@body pet: Pet): { @statusCode _: 201; @header location: string; @body pet: Pet };
    @delete remove(@path id: int64): void;
    @put @route("{id}/rename") rename(@path id: int64, name: string): void;
  }
`;

describe("service IR", () => {
  it("builds service metadata", async () => {
    const { program } = await Tester.compile(spec);
    const [service] = buildApiIR(program).services;
    expect(service).toMatchObject({
      id: "PetStore",
      name: "PetStore",
      title: "Pet Store",
      namespace: ["PetStore"],
      servers: [{ url: "https://api.example.com", description: "prod", parameters: [] }],
      auth: [{ id: "BearerAuth", type: "http", scheme: "Bearer" }],
    });
    expect(service.groups.map((g) => [g.id, g.name, g.namespace])).toEqual([["PetStore.Pets", "Pets", ["PetStore"]]]);
    expect(service.groups[0].decorators).toEqual({});
  });

  it("builds operations with params, bodies and responses", async () => {
    const { program } = await Tester.compile(spec);
    const ir = buildApiIR(program);
    const ops = ir.services[0].groups[0].operations;
    const [get, create, remove, rename] = ops;

    expect(get).toMatchObject({
      id: "PetStore.Pets.get",
      name: "get",
      verb: "get",
      path: "/pets/{id}",
      docs: "Get a pet",
      params: [
        { name: "id", wireName: "id", location: "path", type: { kind: "scalar", name: "int64" }, optional: false },
        { name: "verbose", wireName: "verbose", location: "query", optional: true },
        { name: "trace", wireName: "x-trace", location: "header", optional: true },
      ],
    });
    expect(get.body).toBeUndefined();
    expect(get.responses).toMatchObject([
      { statusCodes: 200, isError: false, headers: [], body: { type: { kind: "named", id: "PetStore.Pet" } } },
      { statusCodes: "default", isError: true, body: { type: { kind: "named", id: "PetStore.ApiError" } } },
    ]);

    expect(create.body).toEqual({
      type: { kind: "named", id: "PetStore.Pet" },
      contentTypes: ["application/json"],
      optional: false,
      kind: "single",
    });
    expect(create.responses).toMatchObject([
      {
        statusCodes: 201,
        headers: [{ name: "location", wireName: "location", type: { kind: "scalar", name: "string" }, optional: false }],
        body: { type: { kind: "named", id: "PetStore.Pet" } },
      },
    ]);

    expect(remove.responses).toMatchObject([{ statusCodes: 204, headers: [] }]);
    expect(remove.responses[0].body).toBeUndefined();

    expect(rename.path).toBe("/pets/{id}/rename");
    expect(rename.body?.type).toEqual({ kind: "named", id: "$anon.RenameRequest" });
    expect(ir.types.find((t) => t.id === "$anon.RenameRequest")).toMatchObject({
      kind: "model",
      properties: [{ name: "name" }],
    });
  });

  it("does not collect HTTP envelope models as data types", async () => {
    const { program } = await Tester.compile(`
      @service namespace S;
      model Pet { id: int64 }
      model PetCreated { @statusCode _: 201; @body pet: Pet }
      @post op create(@body pet: Pet): PetCreated;
    `);
    const ids = buildApiIR(program).types.map((t) => t.id);
    expect(ids).toContain("S.Pet");
    expect(ids).not.toContain("S.PetCreated");
  });

  it("groups namespace-level operations under the namespace", async () => {
    const { program } = await Tester.compile(`
      @service namespace S;
      @route("/ping") op ping(): void;
    `);
    const [service] = buildApiIR(program).services;
    expect(service.groups.map((g) => [g.id, g.name])).toEqual([["S", "S"]]);
  });
});
