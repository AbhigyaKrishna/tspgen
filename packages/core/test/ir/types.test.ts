import { mockFile } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { buildApiIR, type ApiIR, type TypeIR } from "../../src/index.js";
import { Tester } from "../tester.js";

async function build(code: string, options: { generics?: boolean } = {}): Promise<ApiIR> {
  const { program } = await Tester.compile(code);
  return buildApiIR(program, options);
}

function find(ir: ApiIR, id: string): TypeIR {
  const found = ir.types.find((t) => t.id === id);
  if (!found) throw new Error(`type ${id} not found in ${ir.types.map((t) => t.id).join(", ")}`);
  return found;
}

describe("type IR", () => {
  it("maps model properties, scalars, arrays, maps, nullables, literals and defaults", async () => {
    const ir = await build(`
      @service namespace Pets;
      /** A pet */
      model Pet {
        id: int64;
        name?: string;
        tags: string[];
        attrs: Record<int32>;
        @encodedName("application/json", "born_at") bornAt: utcDateTime;
        owner: Owner | null;
        status: "active" = "active";
      }
      model Owner { name: string }
    `);
    expect(find(ir, "Pets.Pet")).toEqual({
      kind: "model",
      id: "Pets.Pet",
      name: "Pet",
      namespace: ["Pets"],
      docs: "A pet",
      decorators: {},
      properties: [
        { name: "id", wireName: "id", type: { kind: "scalar", name: "int64" }, optional: false, decorators: {} },
        { name: "name", wireName: "name", type: { kind: "scalar", name: "string" }, optional: true, decorators: {} },
        {
          name: "tags",
          wireName: "tags",
          type: { kind: "array", of: { kind: "scalar", name: "string" } },
          optional: false,
          decorators: {},
        },
        {
          name: "attrs",
          wireName: "attrs",
          type: { kind: "map", of: { kind: "scalar", name: "int32" } },
          optional: false,
          decorators: {},
        },
        {
          name: "bornAt",
          wireName: "born_at",
          type: { kind: "scalar", name: "utcDateTime" },
          optional: false,
          decorators: {},
        },
        {
          name: "owner",
          wireName: "owner",
          type: { kind: "nullable", of: { kind: "named", id: "Pets.Owner" } },
          optional: false,
          decorators: {},
        },
        {
          name: "status",
          wireName: "status",
          type: { kind: "literal", value: "active" },
          optional: false,
          default: "active",
          decorators: {},
        },
      ],
    });
  });

  it("collects enums, named unions, custom scalars and anonymous models", async () => {
    const ir = await build(`
      @service namespace Pets;
      enum Color { red, green: "g" }
      scalar petId extends string;
      union Shape { circle: Circle, square: Square }
      model Circle { r: float64 }
      model Square { side: float64 }
      model Thing { id: petId; color: Color; shape: Shape; inline: { x: int32 } }
    `);
    expect(find(ir, "Pets.Color")).toEqual({
      kind: "enum",
      id: "Pets.Color",
      name: "Color",
      namespace: ["Pets"],
      decorators: {},
      members: [
        { name: "red", value: "red", decorators: {} },
        { name: "green", value: "g", decorators: {} },
      ],
    });
    expect(find(ir, "Pets.Shape")).toEqual({
      kind: "union",
      id: "Pets.Shape",
      name: "Shape",
      namespace: ["Pets"],
      decorators: {},
      variants: [
        { name: "circle", type: { kind: "named", id: "Pets.Circle" } },
        { name: "square", type: { kind: "named", id: "Pets.Square" } },
      ],
    });
    const thing = find(ir, "Pets.Thing");
    if (thing.kind !== "model") throw new Error("expected model");
    expect(thing.properties.map((p) => p.type)).toEqual([
      { kind: "scalar", name: "string", custom: { id: "Pets.petId", name: "petId", decorators: {} } },
      { kind: "named", id: "Pets.Color" },
      { kind: "named", id: "Pets.Shape" },
      { kind: "named", id: "$anon.ThingInline" },
    ]);
    expect(find(ir, "$anon.ThingInline")).toMatchObject({ kind: "model", name: "ThingInline", namespace: [] });
  });

  it("records discriminator mapping and base models", async () => {
    const ir = await build(`
      @service namespace Zoo;
      @discriminator("kind") model Animal { kind: string }
      model Dog extends Animal { kind: "dog"; bark: boolean }
      model Cat extends Animal { kind: "cat" }
    `);
    expect(find(ir, "Zoo.Animal")).toMatchObject({
      discriminator: { property: "kind", mapping: { dog: "Zoo.Dog", cat: "Zoo.Cat" } },
    });
    expect(find(ir, "Zoo.Dog")).toMatchObject({ baseId: "Zoo.Animal" });
  });

  it("names template instances from their arguments with generics: false", async () => {
    const ir = await build(
      `
      @service namespace Pets;
      model Page<T> { items: T[] }
      model Pet { id: int64 }
      model Holder { page: Page<Pet> }
    `,
      { generics: false },
    );
    expect(find(ir, "Pets.Page<Pets.Pet>")).toMatchObject({ kind: "model", name: "PagePet" });
  });

  it("collects template models once as generics; uses carry their arguments", async () => {
    const ir = await build(`
      @service namespace Pets;
      model Page<T> { items: T[]; total: int64 }
      model Pair<K, V> { key: K; value: V; pages: Page<V>[] }
      model Pet { id: int64 }
      model Holder { page: Page<Pet>; names: Page<string>; pair: Pair<string, Pet> }
    `);
    const pages = ir.types.filter((t) => t.name === "Page");
    expect(pages).toHaveLength(1);
    const page = pages[0];
    expect(page).toMatchObject({ kind: "model", typeParameters: ["T"] });
    if (page.kind !== "model") throw new Error("expected model");
    expect(page.properties[0].type).toEqual({ kind: "array", of: { kind: "typeParam", name: "T" } });
    const pair = ir.types.find((t) => t.name === "Pair");
    if (pair?.kind !== "model") throw new Error("expected Pair");
    expect(pair.typeParameters).toEqual(["K", "V"]);
    expect(pair.properties[2].type).toEqual({
      kind: "array",
      of: { kind: "named", id: page.id, args: [{ kind: "typeParam", name: "V" }] },
    });
    const holder = find(ir, "Pets.Holder");
    if (holder.kind !== "model") throw new Error("expected model");
    expect(holder.properties.map((p) => p.type)).toEqual([
      { kind: "named", id: page.id, args: [{ kind: "named", id: "Pets.Pet" }] },
      { kind: "named", id: page.id, args: [{ kind: "scalar", name: "string" }] },
      { kind: "named", id: pair.id, args: [{ kind: "scalar", name: "string" }, { kind: "named", id: "Pets.Pet" }] },
    ]);
    expect(ir.types.some((t) => t.name === "PagePet")).toBe(false);
  });

  it("keeps per-instance models for templates that cannot be generic", async () => {
    const ir = await build(`
      @service namespace Pets;
      model Pet { id: int64 }
      model Base { id: string }
      model Spread<T> { ...T; extra: string }
      model Derived<T> extends Base { item: T }
      @friendlyName("{name}Named", T) model Named<T> { item: T }
      model Holder { a: Spread<Pet>; b: Derived<Pet>; c: Named<Pet> }
    `);
    const holder = find(ir, "Pets.Holder");
    if (holder.kind !== "model") throw new Error("expected model");
    for (const p of holder.properties) expect(p.type).toMatchObject({ kind: "named" });
    for (const p of holder.properties) expect("args" in p.type).toBe(false);
    expect(ir.types.map((t) => t.name)).toEqual(expect.arrayContaining(["SpreadPet", "DerivedPet", "PetNamed"]));
    expect(ir.types.some((t) => t.kind === "model" && t.typeParameters)).toBe(false);
  });

  it("captures custom decorator applications as plain data", async () => {
    const tester = Tester.files({
      "acme.js": mockFile.js({ $decorators: { Acme: { tag: () => {} } } }),
    }).import("./acme.js");
    const { program } = await tester.compile(`
      namespace Acme { extern dec tag(target: unknown, value: valueof string); }
      @service namespace Pets {
        @Acme.tag("x") model M { @Acme.tag("y") @Acme.tag("z") p: string }
      }
    `);
    const ir = buildApiIR(program);
    const m = find(ir, "Pets.M");
    if (m.kind !== "model") throw new Error("expected model");
    expect(m.decorators).toEqual({ "Acme.tag": [["x"]] });
    expect(m.properties[0].decorators["Acme.tag"]).toHaveLength(2);
  });
});
