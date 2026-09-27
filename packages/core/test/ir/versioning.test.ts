import { resolvePath, type Program } from "@typespec/compiler";
import { createTester, expectDiagnostics } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { apiVersionConstants, buildApiIR, loadVersioning, resolveServices, type ApiIR, type EnumIR, type ModelIR } from "../../src/index.js";
import { Tester } from "../tester.js";

const VersionedTester = createTester(resolvePath(import.meta.dirname, "../.."), {
  libraries: ["@typespec/http", "@typespec/versioning", "@abhigyakrishna/tspgen-core"],
})
  .importLibraries()
  .using("Http", "Versioning", "TspGen");

async function build(code: string, version?: string): Promise<{ program: Program; ir: ApiIR }> {
  const program = (await VersionedTester.compile(code)).program;
  const ir = buildApiIR(program, { versioning: (await loadVersioning(program)).versioning, ...(version ? { version } : {}) });
  return { program, ir };
}

const model = (ir: ApiIR, id: string) => ir.types.find((t) => t.id === id) as ModelIR | undefined;
const props = (ir: ApiIR, id: string) => model(ir, id)?.properties.map((p) => `${p.name}${p.optional ? "?" : ""}`);
const ops = (ir: ApiIR) => ir.services.flatMap((s) => s.groups.flatMap((g) => g.operations.map((o) => `${o.verb} ${o.path}`)));

const petStore = `
  /** The pet store. */
  @service(#{ title: "Pets" })
  @server("https://pets.example.com", "prod")
  @useAuth(BearerAuth)
  @versioned(Versions)
  namespace PetStore;

  enum Versions { v1: "2024-01-01", v2: "2024-06-01", v3: "2025-01-01" }

  /** A pet. */
  @meta("*", #{ table: "pets" })
  model Pet {
    id: int64;
    @renamedFrom(Versions.v2, "title") name: string;
    @added(Versions.v2) /** Age in years. */ age?: int32;
    @removed(Versions.v3) legacy?: string;
    @madeOptional(Versions.v2) tag?: string;
    @typeChangedFrom(Versions.v3, string) weight: float64;
    @encodedName("application/json", "kind_of") kind: Kind;
  }

  enum Kind { dog, cat, @added(Versions.v2) bird }

  @added(Versions.v2) model Toy { name: string }
  @removed(Versions.v2) model OldToy { name: string }
  @renamedFrom(Versions.v3, "Owner") model Keeper { name: string }
  model Leash { length: int32 }

  @route("/pets") interface Pets {
    /** List pets. */
    @get list(@added(Versions.v2) @query filter?: string, @removed(Versions.v3) @query legacy?: string): Pet[];
    @added(Versions.v2) @post create(@body pet: Pet): Pet;
    @removed(Versions.v3) @delete remove(@path id: int64): void;
    @returnTypeChangedFrom(Versions.v2, Keeper) @get @route("keeper") keeper(): Leash;
  }
`;

describe("versioning", () => {
  it("builds the latest version by default", async () => {
    const { program, ir } = await build(petStore);
    expect(program.diagnostics).toEqual([]);
    const [service] = ir.services;
    expect(service.version).toEqual({ name: "v3", value: "2025-01-01" });
    expect(props(ir, "PetStore.Pet")).toEqual(["id", "name", "age?", "tag?", "weight", "kind"]);
    expect(model(ir, "PetStore.Pet")!.properties.find((p) => p.name === "weight")!.type).toEqual({
      kind: "scalar",
      name: "float64",
    });
    expect((ir.types.find((t) => t.id === "PetStore.Kind") as EnumIR).members.map((m) => m.name)).toEqual([
      "dog",
      "cat",
      "bird",
    ]);
    expect(ir.types.map((t) => t.id)).toEqual(["PetStore.Keeper", "PetStore.Kind", "PetStore.Leash", "PetStore.Pet", "PetStore.Toy"]);
    expect(ops(ir)).toEqual(["get /pets", "post /pets", "get /pets/keeper"]);
    const list = service.groups[0].operations[0];
    expect(list.params.map((p) => p.name)).toEqual(["filter"]);
    const keeper = service.groups[0].operations.find((o) => o.name === "keeper")!;
    expect(keeper.responses[0].body?.type).toEqual({ kind: "named", id: "PetStore.Leash" });
  });

  it("builds an older version chosen by name", async () => {
    const { program, ir } = await build(petStore, "v1");
    expect(program.diagnostics).toEqual([]);
    expect(ir.services[0].version).toEqual({ name: "v1", value: "2024-01-01" });
    expect(props(ir, "PetStore.Pet")).toEqual(["id", "title", "legacy?", "tag", "weight", "kind"]);
    expect(model(ir, "PetStore.Pet")!.properties.find((p) => p.name === "weight")!.type).toEqual({
      kind: "scalar",
      name: "string",
    });
    expect((ir.types.find((t) => t.id === "PetStore.Kind") as EnumIR).members.map((m) => m.name)).toEqual(["dog", "cat"]);
    expect(ir.types.map((t) => t.id)).toEqual(["PetStore.Kind", "PetStore.Leash", "PetStore.OldToy", "PetStore.Owner", "PetStore.Pet"]);
    expect(ops(ir)).toEqual(["get /pets", "delete /pets/{id}", "get /pets/keeper"]);
    const [list, , keeper] = ir.services[0].groups[0].operations;
    expect(list.params.map((p) => p.name)).toEqual(["legacy"]);
    expect(keeper.responses[0].body?.type).toEqual({ kind: "named", id: "PetStore.Owner" });
  });

  it("builds a version chosen by value", async () => {
    const { ir } = await build(petStore, "2024-06-01");
    expect(ir.services[0].version).toEqual({ name: "v2", value: "2024-06-01" });
    expect(props(ir, "PetStore.Pet")).toEqual(["id", "name", "age?", "legacy?", "tag?", "weight", "kind"]);
    expect(ops(ir)).toEqual(["get /pets", "post /pets", "delete /pets/{id}", "get /pets/keeper"]);
    expect(ir.services[0].groups[0].operations[0].params.map((p) => p.name)).toEqual(["filter", "legacy"]);
  });

  it("keeps decorator state on the versioned types", async () => {
    const { ir } = await build(petStore, "v2");
    const [service] = ir.services;
    expect(service).toMatchObject({
      id: "PetStore",
      name: "PetStore",
      title: "Pets",
      docs: "The pet store.",
      namespace: ["PetStore"],
      servers: [{ url: "https://pets.example.com", description: "prod" }],
      auth: [{ id: "BearerAuth", type: "http", scheme: "Bearer" }],
    });
    const list = service.groups[0].operations[0];
    expect(list).toMatchObject({ id: "PetStore.Pets.list", path: "/pets", docs: "List pets." });
    expect(list.params[0]).toMatchObject({ name: "filter", location: "query" });
    const pet = model(ir, "PetStore.Pet")!;
    expect(pet.docs).toBe("A pet.");
    expect(pet.decorators).toEqual({ "TspGen.meta": [["*", { table: "pets" }]] });
    expect(pet.properties.find((p) => p.name === "age")!.docs).toBe("Age in years.");
    expect(pet.properties.find((p) => p.name === "kind")!.wireName).toBe("kind_of");
  });

  it("resolves @useAuth on the versioned operations", async () => {
    const code = `
      @service @useAuth(BearerAuth) @versioned(Versions) namespace S;
      enum Versions { v1, v2 }
      model Key is ApiKeyAuth<ApiKeyLocation.header, "X-Key">;
      @route("/pets") interface Pets {
        @get list(): void;
        @useAuth(NoAuth) @get @route("public") featured(): void;
        @added(Versions.v2) @useAuth(BearerAuth | Key) @delete remove(@path id: int64): void;
      }
    `;
    const auth = (ir: ApiIR) => ({
      service: ir.services[0].auth,
      ops: Object.fromEntries(ir.services[0].groups.flatMap((g) => g.operations).map((o) => [o.name, o.auth])),
    });
    const v1 = await build(code, "v1");
    expect(v1.program.diagnostics).toEqual([]);
    expect(auth(v1.ir)).toEqual({
      service: [
        { id: "BearerAuth", type: "http", scheme: "Bearer" },
        { id: "NoAuth", type: "noAuth" },
      ],
      ops: { list: { options: [["BearerAuth"]] }, featured: { options: [[]] } },
    });
    const v2 = await build(code, "v2");
    expect(v2.program.diagnostics).toEqual([]);
    expect(auth(v2.ir)).toEqual({
      service: [
        { id: "BearerAuth", type: "http", scheme: "Bearer" },
        { id: "NoAuth", type: "noAuth" },
        { id: "Key", type: "apiKey", in: "header", name: "X-Key" },
      ],
      ops: {
        list: { options: [["BearerAuth"]] },
        featured: { options: [[]] },
        remove: { options: [["BearerAuth"], ["Key"]] },
      },
    });
  });

  it("reports an unknown version and skips the service", async () => {
    const { program, ir } = await build(petStore, "v9");
    expectDiagnostics(program.diagnostics, {
      code: "@abhigyakrishna/tspgen-core/unknown-version",
      message:
        `Version 'v9' is not a version of service 'PetStore'; valid versions: v1 ("2024-01-01"), v2 ("2024-06-01"), ` +
        `v3 ("2025-01-01"). Nothing is generated.`,
    });
    expect(ir.services).toEqual([]);
  });

  it("marks the resolution failed on an unknown version", async () => {
    const program = (await VersionedTester.compile(petStore)).program;
    const { versioning } = await loadVersioning(program);
    expect(resolveServices(program, versioning, "v9")).toMatchObject({ services: [], failed: true });
    expect(resolveServices(program, versioning, "v1")).toMatchObject({ failed: false });
  });

  it("prefers a version name over a version value", async () => {
    const { ir } = await build(
      `@service @versioned(V) namespace S; enum V { v1: "v2", v2: "v3" } model M { @added(V.v2) b?: string }`,
      "v2",
    );
    expect(ir.services[0].version).toEqual({ name: "v2", value: "v3" });
    expect(props(ir, "S.M")).toEqual(["b?"]);
    const byValue = await build(`@service @versioned(V) namespace S; enum V { v1: "v2", v2: "v3" }`, "v3");
    expect(byValue.ir.services[0].version).toEqual({ name: "v2", value: "v3" });
  });

  it("warns when a version is set but nothing is versioned", async () => {
    const program = (await Tester.compile(`@service namespace S; @route("/a") op a(): void;`)).program;
    const ir = buildApiIR(program, { versioning: (await loadVersioning(program)).versioning, version: "v1" });
    expectDiagnostics(program.diagnostics, { code: "@abhigyakrishna/tspgen-core/unused-version" });
    expect(ir.services).toHaveLength(1);
  });

  it("builds the whole graph without the versioning API (unmutated)", async () => {
    const program = (await VersionedTester.compile(petStore)).program;
    const ir = buildApiIR(program);
    expect(ir.services[0].version).toBeUndefined();
    expect(props(ir, "PetStore.Pet")).toEqual(["id", "name", "age?", "legacy?", "tag?", "weight", "kind"]);
    expect(ir.types.map((t) => t.id)).toContain("PetStore.Versions");
  });

  it("does not load versioning for unversioned programs", async () => {
    const program = (await Tester.compile(`@service namespace S;`)).program;
    expect(await loadVersioning(program)).toEqual({ failed: false });
  });

  it("applies a transient (@useDependency) version", async () => {
    const { program, ir } = await build(`
      @versioned(Versions) namespace Lib {
        enum Versions { v1, v2 }
        model Item { id: string; @added(Versions.v2) extra?: string }
      }
      @service @useDependency(Lib.Versions.v1) namespace Api {
        @route("/items") op list(): Lib.Item[];
      }
    `);
    expect(program.diagnostics).toEqual([]);
    expect(ir.services.map((s) => [s.id, s.version])).toEqual([["Api", undefined]]);
    expect(props(ir, "Lib.Item")).toEqual(["id"]);
  });

  const threeServices = `
      @service @versioned(AV) namespace A {
        enum AV { v1, v2 }
        model AM { @added(AV.v2) a?: string; x: string }
        @route("/a") op a(): AM;
      }
      @service @versioned(BV) namespace B {
        enum BV { v1, v3 }
        model BM { @added(BV.v3) b?: string; y: string }
        @route("/b") op b(): BM;
      }
      @service namespace C {
        model CM { z: string }
        @route("/c") op c(): CM;
      }
    `;

  it("builds several services: versioned ones at the requested version, unversioned ones as-is", async () => {
    const { program, ir } = await build(threeServices, "v1");
    expect(program.diagnostics).toEqual([]);
    expect(ir.services.map((s) => [s.id, s.version?.name])).toEqual([
      ["A", "v1"],
      ["B", "v1"],
      ["C", undefined],
    ]);
    expect(props(ir, "A.AM")).toEqual(["x"]);
    expect(props(ir, "B.BM")).toEqual(["y"]);
    expect(ir.types.map((t) => t.id)).toEqual(["A.AM", "B.BM", "C.CM"]);

    const v2 = await build(threeServices, "v2");
    expectDiagnostics(v2.program.diagnostics, { code: "@abhigyakrishna/tspgen-core/unknown-version" });
    expect(v2.ir.services.map((s) => s.id)).toEqual(["A", "C"]);
  });

  it("does not collect the version enum, but collects it where it is referenced", async () => {
    const { ir } = await build(`
      @service @versioned(Versions) namespace S;
      enum Versions { v1 }
      model M { v: Versions }
      @route("/m") op m(): M;
    `);
    expect(ir.types.map((t) => t.id)).toEqual(["S.M", "S.Versions"]);
    const unused = await build(`@service @versioned(Versions) namespace S; enum Versions { v1 } @route("/m") op m(): void;`);
    expect(unused.ir.types).toEqual([]);
  });

  it("keeps types outside the service namespace under their own ids", async () => {
    const { program, ir } = await build(`
      namespace Common { model Shared { x: string } }
      @service @versioned(Versions) namespace S {
        enum Versions { v1, v2 }
        model M { shared: Common.Shared; @added(Versions.v2) more?: Common.Shared }
        @route("/m") op m(): M;
      }
      @service namespace Other { @route("/o") op o(): Common.Shared; }
    `);
    expect(program.diagnostics).toEqual([]);
    expect(ir.types.map((t) => t.id)).toEqual(["Common.Shared", "S.M"]);
    expect(props(ir, "S.M")).toEqual(["shared", "more?"]);
  });

  it("warns when services see a type at different versions", async () => {
    const { program, ir } = await build(`
      @service @versioned(Versions) namespace S {
        enum Versions { v1, v2 }
        model Pet { id: string; @added(Versions.v2) age?: int32 }
        @route("/pets") op pets(): Pet;
      }
      @service @useDependency(S.Versions.v1) namespace Dep { @route("/d") op d(): S.Pet; }
    `);
    expectDiagnostics(program.diagnostics, {
      code: "@abhigyakrishna/tspgen-core/version-conflict",
      message: "Type 'S.Pet' is used by several services at different versions; the first one is generated.",
    });
    expect(props(ir, "S.Pet")).toEqual(["id", "age?"]);
  });

  describe("template models", () => {
    const spec = `
      @service @versioned(Versions) namespace S;
      enum Versions { v1, v2 }
      model Page<T> { items: T[]; @added(Versions.v2) next?: string }
      model Box<T> { value: T; @added(Versions.v2) label?: string; meta: Meta }
      model Meta { a: string; @added(Versions.v2) b?: string }
      model Wrap<T> { value: T; meta: Meta }
      model Pet { name: string }
      @route("/pets") op pets(): Page<Pet>;
      @route("/box") op box(): Box<Pet>;
      @route("/wrap") op wrap(): Wrap<Pet>;
    `;

    it("stay generic where the version has every declared property", async () => {
      const { program, ir } = await build(spec);
      expect(program.diagnostics).toEqual([]);
      expect(ir.types.map((t) => t.id)).toEqual(["S.Box<T>", "S.Meta", "S.Page<T>", "S.Pet", "S.Wrap<T>"]);
      expect(props(ir, "S.Page<T>")).toEqual(["items", "next?"]);
      expect(props(ir, "S.Meta")).toEqual(["a", "b?"]);
      const box = ir.services[0].groups[0].operations[1];
      expect(box.responses[0].body?.type).toEqual({ kind: "named", id: "S.Box<T>", args: [{ kind: "named", id: "S.Pet" }] });
    });

    it("become one model per instance where the version removes declared properties", async () => {
      const { program, ir } = await build(spec, "v1");
      expect(program.diagnostics).toEqual([]);
      expect(ir.types.map((t) => t.id)).toEqual(["S.Box<S.Pet>", "S.Meta", "S.Page<S.Pet>", "S.Pet", "S.Wrap<T>"]);
      expect(props(ir, "S.Page<S.Pet>")).toEqual(["items"]);
      expect(props(ir, "S.Box<S.Pet>")).toEqual(["value", "meta"]);
      expect(props(ir, "S.Meta")).toEqual(["a"]);
      // The generic declaration is the versioned clone: its `meta` is Meta at v1.
      const wrap = model(ir, "S.Wrap<T>")!;
      expect(wrap.properties.map((p) => [p.name, p.type])).toEqual([
        ["value", { kind: "typeParam", name: "T" }],
        ["meta", { kind: "named", id: "S.Meta" }],
      ]);
    });
  });
});

describe("apiVersionConstants", () => {
  const svc = (id: string, value?: string) => ({ id, name: id.split(".").pop()!, ...(value ? { version: { value } } : {}) });

  it("names one versioned service's constant API_VERSION", () => {
    expect(apiVersionConstants({ services: [svc("PetStore", "2024-01-01"), svc("Other")] })).toEqual([
      { name: "API_VERSION", value: "2024-01-01", serviceId: "PetStore" },
    ]);
  });

  it("prefixes the service name when several services are versioned", () => {
    expect(
      apiVersionConstants({ services: [svc("PetStore", "1"), svc("myAPI.Store", "2"), svc("Other.Store", "3")] }).map((c) => c.name),
    ).toEqual(["PET_STORE_API_VERSION", "MY_API_STORE_API_VERSION", "OTHER_STORE_API_VERSION"]);
  });
});

describe("versioning diagnostics", () => {
  it("does not report decorator diagnostics again for the versioned clones", async () => {
    const [{ program }] = await VersionedTester.compileAndDiagnose(`
      @service @versioned(V) namespace S;
      enum V { v1 }
      model M { @minValue(1) @maxValue(0) a: int32 }
      @route("/m") op m(): M;
    `);
    expect(program.diagnostics.map((d) => d.code)).toEqual(["invalid-range"]);
    buildApiIR(program, { versioning: (await loadVersioning(program)).versioning });
    expect(program.diagnostics.map((d) => d.code)).toEqual(["invalid-range"]);
  });
});

describe("version-specific diagnostics", () => {
  it("reports diagnostics that only the versioned clones have", async () => {
    const { program } = await VersionedTester.compileAndDiagnose(`
      @service @versioned(V) namespace S;
      enum V { v1, v2 }
      model M { @typeChangedFrom(V.v2, int32) @maxLength(3) name: string }
      @route("/m") op m(): M;
    `).then(([result]) => result);
    expect(program.diagnostics).toEqual([]);
    buildApiIR(program, { versioning: (await loadVersioning(program)).versioning, version: "v1" });
    expectDiagnostics(program.diagnostics, {
      code: "decorator-wrong-target",
      message: "Cannot apply @maxLength decorator to type it is not a string",
    });
  });
});
