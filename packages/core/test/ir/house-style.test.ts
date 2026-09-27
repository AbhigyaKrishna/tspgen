import { resolvePath } from "@typespec/compiler";
import { createTester } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { buildApiIR, metaScopes, type ModelIR } from "../../src/index.js";

const MetaTester = createTester(resolvePath(import.meta.dirname, "../.."), {
  libraries: ["@typespec/http", "@abhigyakrishna/tspgen-core"],
})
  .importLibraries()
  .using("Http", "TspGen");

describe("IR facts for house-style features", () => {
  it("records enclosing namespace decorators on groups, service namespace first", async () => {
    const { program } = await MetaTester.compile(`
      @meta("*", #{ level: "root" })
      @service namespace S {
        @meta("*", #{ level: "graph" })
        namespace Graph {
          @route("/nodes") interface Nodes { @get list(): void; }
        }
        @route("/top") @get op top(): void;
      }
    `);
    const groups = buildApiIR(program).services[0].groups;
    const nodes = groups.find((g) => g.name === "Nodes")!;
    expect(nodes.namespaceDecorators.map(metaScopes)).toEqual([{ "*": { level: "root" } }, { "*": { level: "graph" } }]);
    const root = groups.find((g) => g.name === "S")!;
    expect(root.namespaceDecorators).toEqual([]);
  });

  it("also reaches namespaces above the service namespace (unified with types)", async () => {
    const { program } = await MetaTester.compile(`
      @meta("*", #{ level: "outer" })
      namespace Acme {
        @service namespace Pets {
          @route("/p") @get op list(): void;
        }
      }
    `);
    const groups = buildApiIR(program).services[0].groups;
    const root = groups.find((g) => g.name === "Pets")!;
    expect(root.namespaceDecorators.map(metaScopes)).toEqual([{ "*": { level: "outer" } }]);
  });

  it("records template arguments of decorated template instances (generics: false)", async () => {
    const { program } = await MetaTester.compile(`
      @service namespace S;
      @meta("*", #{}) model Page<T> { items: T[] }
      model Node { id: string }
      model Holder { page: Page<Node> }
    `);
    const ir = buildApiIR(program, { generics: false });
    const page = ir.types.find((t) => t.name === "PageNode") as ModelIR;
    expect(page.templateArgs).toEqual([{ kind: "named", id: "S.Node" }]);
    expect((ir.types.find((t) => t.id === "S.Node") as ModelIR).templateArgs).toBeUndefined();
  });

  it("keeps decorators of a generic template declaration", async () => {
    const { program } = await MetaTester.compile(`
      @service namespace S;
      @meta("*", #{ tag: "page" }) model Page<T> { items: T[] }
      model Node { id: string }
      model Holder { page: Page<Node> }
    `);
    const ir = buildApiIR(program);
    const page = ir.types.find((t) => t.name === "Page") as ModelIR;
    expect(page.typeParameters).toEqual(["T"]);
    expect(Object.keys(page.decorators)).toContain("TspGen.meta");
    expect(page.templateArgs).toBeUndefined();
  });

  it("records constraint decorators from properties and their scalars", async () => {
    const { program } = await MetaTester.compile(`
      @service namespace S;
      @maxLength(64) scalar id extends string;
      model M {
        @minLength(1) @maxLength(200) name: string;
        key: id;
        @pattern("^[a-z]+$") slug?: string;
        @minItems(1) @maxItems(5) tags: string[];
        @minValue(0) @maxValue(10) score: int32;
        plain: string;
      }
    `);
    const m = buildApiIR(program).types.find((t) => t.id === "S.M") as ModelIR;
    expect(Object.fromEntries(m.properties.map((p) => [p.name, p.constraints]))).toEqual({
      name: { minLength: 1, maxLength: 200 },
      key: { maxLength: 64 },
      slug: { pattern: "^[a-z]+$" },
      tags: { minItems: 1, maxItems: 5 },
      score: { minValue: 0, maxValue: 10 },
      plain: undefined,
    });
    expect("constraints" in m.properties.find((p) => p.name === "plain")!).toBe(false);
  });

  it("records scalar-level constraints through a nullable union", async () => {
    const { program } = await MetaTester.compile(`
      @service namespace S;
      scalar Slug extends string;
      @@pattern(Slug, "^[a-z]+$");
      model M { a: Slug; b: Slug | null; @maxLength(4) c: Slug | null; d: Slug | string }
    `);
    const m = buildApiIR(program).types.find((t) => t.id === "S.M") as ModelIR;
    expect(Object.fromEntries(m.properties.map((p) => [p.name, p.constraints]))).toEqual({
      a: { pattern: "^[a-z]+$" },
      b: { pattern: "^[a-z]+$" },
      c: { maxLength: 4, pattern: "^[a-z]+$" },
      d: undefined,
    });
  });

  it("skips intrinsic template arguments and reports no extra unsupported-type diagnostic", async () => {
    const [{ program }, diagnostics] = await MetaTester.compileAndDiagnose(`
      @service namespace S;
      @meta("*", #{}) model Opt<A, B> { a: A }
      model Holder { opt: Opt<string, never> }
    `);
    const ir = buildApiIR(program);
    const opt = ir.types.find((t) => t.name === "OptStringNever") as ModelIR;
    expect(opt.templateArgs).toEqual([{ kind: "scalar", name: "string" }]);
    expect(diagnostics.filter((d) => d.code.includes("unsupported-type"))).toEqual([]);
  });

  it("does not record template arguments of undecorated instances (generics: false)", async () => {
    const { program } = await MetaTester.compile(`
      namespace Lib { model Tag { t: string } model Wrapper<T> { x: string } }
      @service namespace S {
        @route("/w") @get op w(): Lib.Wrapper<Lib.Tag>;
      }
    `);
    const ir = buildApiIR(program, { generics: false });
    expect(ir.types.find((t) => t.id === "Lib.Tag")).toBeUndefined();
    const wrapper = ir.types.find((t) => t.name === "WrapperTag") as ModelIR;
    expect(wrapper).toBeDefined();
    expect(wrapper.templateArgs).toBeUndefined();
  });

  it("resolves template arguments after properties so inline-model args keep property-based names (generics: false)", async () => {
    const { program } = await MetaTester.compile(`
      @service namespace S;
      @meta("*", #{}) model Page<T> { items: T[] }
      model H { p: Page<{ x: string }> }
    `);
    const ir = buildApiIR(program, { generics: false });
    const inline = ir.types.find((t) => t.name === "PageItemsItem") as ModelIR;
    expect(inline).toBeDefined();
    expect(inline.templateArgs).toBeUndefined();
  });
});
