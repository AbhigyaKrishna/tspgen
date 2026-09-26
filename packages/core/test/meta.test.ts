import { resolvePath } from "@typespec/compiler";
import { createTester, expectDiagnostics } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { buildApiIR, mergeMeta, metaScopes, metaStrings, resolveMeta, type MetaScopes } from "../src/index.js";

const MetaTester = createTester(resolvePath(import.meta.dirname, ".."), {
  libraries: ["@typespec/http", "@abhigyakrishna/tspgen-core"],
})
  .importLibraries()
  .using("Http", "TspGen");

describe("meta resolution", () => {
  it("merges keys, later wins, arrays concatenate", () => {
    expect(mergeMeta({ a: 1, list: ["x"], o: { k: 1 } }, { a: 2, list: ["y"], o: { j: 2 } })).toEqual({
      a: 2,
      list: ["x", "y"],
      o: { j: 2 },
    });
  });

  it("groups decorator applications by scope and resolves * → language → target", () => {
    const scopes = metaScopes({
      "TspGen.meta": [
        ["*", { owner: "a", annotations: ["@All"] }],
        ["kotlin", { table: "pets", annotations: ["@K"] }],
        ["kotlin:ktor-server", { table: "server_pets" }],
        ["typescript", { readonly: true }],
        ["kotlin", { annotations: ["@K2"] }],
      ],
    });
    expect(scopes.kotlin).toEqual({ table: "pets", annotations: ["@K", "@K2"] });
    expect(resolveMeta(scopes, "kotlin")).toEqual({ owner: "a", table: "pets", annotations: ["@All", "@K", "@K2"] });
    expect(resolveMeta(scopes, "kotlin", "ktor-server")).toMatchObject({ table: "server_pets" });
    expect(resolveMeta(scopes, "typescript")).toEqual({ owner: "a", annotations: ["@All"], readonly: true });
    expect(resolveMeta(undefined as MetaScopes | undefined, "kotlin")).toEqual({});
  });
});

describe("TspGen.meta decorator", () => {
  it("compiles on types, properties and operations, including @@meta augments", async () => {
    const { program } = await MetaTester.compile(`
      @service namespace S {
        @meta("kotlin", #{ annotations: #["@Entity"], n: 3, nested: #{ a: true } })
        model Pet { @meta("typescript", #{ readonly: true }) id: int64 }
        @meta("*", #{ owner: "team" })
        interface Pets { @route("/p") @get get(): Pet; }
      }
      @@meta(S.Pets.get, "kotlin:ktor-server", #{ authenticate: "jwt" });
    `);
    const ir = buildApiIR(program);
    const pet = ir.types.find((t) => t.id === "S.Pet")!;
    expect(metaScopes(pet.decorators)).toEqual({ kotlin: { annotations: ["@Entity"], n: 3, nested: { a: true } } });
    if (pet.kind !== "model") throw new Error();
    expect(metaScopes(pet.properties[0].decorators)).toEqual({ typescript: { readonly: true } });
    const group = ir.services[0].groups[0];
    expect(metaScopes(group.decorators)).toEqual({ "*": { owner: "team" } });
    expect(metaScopes(group.operations[0].decorators)).toEqual({ "kotlin:ktor-server": { authenticate: "jwt" } });
  });

  it("typed readers report invalid-meta for wrong types", async () => {
    const { program } = await MetaTester.compile(`model M {}`);
    expect(metaStrings(program, { annotations: "@One" }, "annotations", "M")).toEqual(["@One"]);
    expect(metaStrings(program, { annotations: 5 }, "annotations", "M")).toEqual([]);
    expectDiagnostics(program.diagnostics, {
      code: "@abhigyakrishna/tspgen-core/invalid-meta",
      message: "Metadata key 'annotations' on 'M' must be a string or a list of strings; it is ignored.",
    });
  });
});
