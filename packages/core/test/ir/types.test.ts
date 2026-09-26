import { mockFile } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { buildApiIR, type ApiIR, type TypeIR } from "../../src/index.js";
import { Tester } from "../tester.js";

async function build(code: string): Promise<ApiIR> {
  const { program } = await Tester.compile(code);
  return buildApiIR(program);
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

  it("names template instances from their arguments", async () => {
    const ir = await build(`
      @service namespace Pets;
      model Page<T> { items: T[] }
      model Pet { id: int64 }
      model Holder { page: Page<Pet> }
    `);
    expect(find(ir, "Pets.Page<Pets.Pet>")).toMatchObject({ kind: "model", name: "PagePet" });
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
