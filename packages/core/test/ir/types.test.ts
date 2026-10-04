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
      {
        kind: "scalar",
        name: "string",
        custom: { id: "Pets.petId", name: "petId", namespace: ["Pets"], root: "string", decorators: {} },
      },
      { kind: "named", id: "Pets.Color" },
      { kind: "named", id: "Pets.Shape" },
      { kind: "named", id: "$anon.ThingInline" },
    ]);
    expect(find(ir, "$anon.ThingInline")).toMatchObject({ kind: "model", name: "ThingInline", namespace: [] });
  });

  it("describes custom scalars with their namespace, docs and constraints", async () => {
    const ir = await build(`
      @service namespace Pets;
      /** A pet id. */
      @minLength(3) @pattern("^p") scalar petId extends string;
      model Thing { id: petId }
    `);
    const thing = find(ir, "Pets.Thing");
    if (thing.kind !== "model") throw new Error("expected model");
    expect(thing.properties[0].type).toEqual({
      kind: "scalar",
      name: "string",
      custom: {
        id: "Pets.petId",
        name: "petId",
        namespace: ["Pets"],
        root: "string",
        docs: "A pet id.",
        constraints: { minLength: 3, pattern: "^p" },
        decorators: {},
      },
    });
    // Property constraints still include the scalar's (unchanged).
    expect(thing.properties[0].constraints).toEqual({ minLength: 3, pattern: "^p" });
  });

  it("gives a custom scalar its ultimate std root and own @encode, independent of a property's own @encode", async () => {
    const ir = await build(`
      @service namespace Pets;
      scalar bigId extends int64;
      @encode(string) scalar encodedId extends int64;
      /** A scalar chain: \`shortId\` roots at int64 through \`bigId\`; only \`bigId\` gets its own declaration. */
      scalar shortId extends bigId;
      model Thing {
        a: bigId;
        b: encodedId;
        @encode(string) c: bigId;
        d: shortId;
      }
    `);
    const thing = find(ir, "Pets.Thing");
    if (thing.kind !== "model") throw new Error("expected model");
    const [a, b, c, d] = thing.properties.map((p) => p.type);
    if (a.kind !== "scalar" || b.kind !== "scalar" || c.kind !== "scalar" || d.kind !== "scalar") {
      throw new Error("expected scalar refs");
    }
    // `bigId` has no @encode of its own: unaffected by property `c`'s own @encode(string) applying only to that ref.
    expect(a.custom).toMatchObject({ id: "Pets.bigId", root: "int64" });
    expect(a.custom?.encoding).toBeUndefined();
    expect(a.encoding).toBeUndefined();
    // `encodedId` carries its own @encode(string).
    expect(b.custom).toMatchObject({ id: "Pets.encodedId", root: "int64", encoding: "string" });
    expect(b.encoding).toBe("string");
    // Property `c`'s own @encode(string) is on the ref, not the (unencoded) scalar's CustomScalarIR.
    expect(c.custom).toBe(a.custom);
    expect(c.encoding).toBe("string");
    // `shortId` extends `bigId` (not a std scalar directly): its root is still the ultimate std scalar, int64.
    expect(d.custom).toMatchObject({ id: "Pets.shortId", root: "int64" });
    expect(d.custom?.encoding).toBeUndefined();
  });

  it("exposes every distinct custom scalar in ApiIR.customScalars, one shared object per ref", async () => {
    const ir = await build(`
      @service namespace Pets;
      scalar petId extends string;
      model Thing { a: petId; b: petId; other: int32 }
    `);
    expect(ir.customScalars.map((s) => s.id)).toEqual(["Pets.petId"]);
    const thing = find(ir, "Pets.Thing");
    if (thing.kind !== "model") throw new Error("expected model");
    const [a, b] = thing.properties.map((p) => p.type);
    if (a.kind !== "scalar" || b.kind !== "scalar") throw new Error("expected scalar refs");
    // Every ref to the same scalar (and the entry in `customScalars`) shares one object.
    expect(a.custom).toBe(b.custom);
    expect(a.custom).toBe(ir.customScalars[0]);
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

  it("keeps docs, encoded names and constraints of generic template properties", async () => {
    const ir = await build(`
      @service namespace Pets;
      /** A page */
      model Page<T> {
        /** The items */ @maxItems(100) items: T[];
        @encodedName("application/json", "next_link") nextLink?: string;
        @minLength(3) cursor: string;
      }
      model Pet { id: int64 }
      model Use { p: Page<Pet> }
    `);
    const page = ir.types.find((t) => t.name === "Page");
    if (page?.kind !== "model") throw new Error("expected generic Page");
    expect(page.docs).toBe("A page");
    expect(page.properties.map((p) => [p.name, p.wireName, p.docs, p.constraints])).toEqual([
      ["items", "items", "The items", { maxItems: 100 }],
      ["nextLink", "next_link", undefined, undefined],
      ["cursor", "cursor", undefined, { minLength: 3 }],
    ]);
  });

  it("keeps templates per-instance when a type parameter appears where no generic class can hold it", async () => {
    const ir = await build(`
      @service namespace Pets;
      model Pet { id: int64 }
      model Base { id: string }
      model Link<T> extends Base { target: T }
      model Inline<T> { meta: { first: T } }
      model Either<T> { either: T | string }
      model Linked<T> { next: Link<T> }
      model Fine<T> { a: T | null; b: Record<T>[]; c: Fine<T>[] }
      model Use { a: Inline<Pet>; b: Either<Pet>; c: Linked<Pet>; d: Fine<Pet> }
    `);
    const generic = ir.types.filter((t) => t.kind === "model" && t.typeParameters).map((t) => t.name);
    expect(generic).toEqual(["Fine"]);
    const all = JSON.stringify(ir.types);
    expect(ir.types.filter((t) => t.name !== "Fine").some((t) => JSON.stringify(t).includes('"typeParam"'))).toBe(false);
    expect(all).toContain('"InlinePet"');
  });

  it("gives variants of discriminated unions their own models instead of generic uses", async () => {
    const ir = await build(`
      @service namespace Pets;
      model Pet { id: int64 }
      model Created<T> { data: T }
      model Deleted { id: string }
      @discriminated(#{ envelope: "none", discriminatorPropertyName: "kind" })
      union Event { created: Created<Pet>, deleted: Deleted }
    `);
    const event = find(ir, "Pets.Event");
    if (event.kind !== "union") throw new Error("expected union");
    expect(event.variants[0].type).toEqual({ kind: "named", id: "Pets.Created<Pets.Pet>" });
    expect(find(ir, "Pets.Created<Pets.Pet>")).toMatchObject({ name: "CreatedPet" });
  });

  it("keeps per-instance models for templates that cannot be generic", async () => {
    const ir = await build(`
      @service namespace Pets;
      model Pet { id: int64 }
      model Base { id: string }
      model Spread<T> { ...T; extra: string }
      model Derived<T> extends Base { item: T }
      @friendlyName("{name}Named", T) model Named<T> { item: T }
      model Holder { a: Spread<Pet>; b: Derived<Pet>; c: Named<Pet>; d: Paged<Pet> }
      model Paged<T> { next: Named<T> }
    `);
    const holder = find(ir, "Pets.Holder");
    if (holder.kind !== "model") throw new Error("expected model");
    for (const p of holder.properties) expect(p.type).toMatchObject({ kind: "named" });
    for (const p of holder.properties) expect("args" in p.type).toBe(false);
    expect(ir.types.map((t) => t.name)).toEqual(expect.arrayContaining(["SpreadPet", "DerivedPet", "PetNamed"]));
    expect(ir.types.some((t) => t.kind === "model" && t.typeParameters)).toBe(false);
  });

  it("keeps generic union instances apart, also when nested in template arguments", async () => {
    const ir = await build(`
      @service namespace S;
      union Maybe<T> { T, string }
      union Plain { int32, string }
      model Box<T> { v: T }
      model Holder {
        a: Maybe<Maybe<int32>>;
        b: Maybe<Maybe<boolean>>;
        c: Maybe<Box<Maybe<int32>>>;
        d: Maybe<Box<Maybe<boolean>>>;
        p: Plain;
      }
    `);
    expect(ir.types.map((t) => t.id).filter((id) => id.startsWith("S.Maybe") || id.startsWith("S.Box"))).toEqual(
      expect.arrayContaining([
        "S.Maybe<int32>",
        "S.Maybe<boolean>",
        "S.Maybe<S.Maybe<int32>>",
        "S.Maybe<S.Maybe<boolean>>",
        "S.Maybe<S.Box<S.Maybe<int32>>>",
        "S.Maybe<S.Box<S.Maybe<boolean>>>",
      ]),
    );
    const variants = (id: string) => {
      const union = find(ir, id);
      if (union.kind !== "union") throw new Error("expected union");
      return union.variants.map((v) => v.type);
    };
    expect(variants("S.Maybe<S.Maybe<int32>>")[0]).toEqual({ kind: "named", id: "S.Maybe<int32>" });
    expect(variants("S.Maybe<S.Maybe<boolean>>")[0]).toEqual({ kind: "named", id: "S.Maybe<boolean>" });
    expect(variants("S.Maybe<int32>")[0]).toEqual({ kind: "scalar", name: "int32" });
    expect(variants("S.Maybe<boolean>")[0]).toEqual({ kind: "scalar", name: "boolean" });
    expect(JSON.stringify(variants("S.Maybe<S.Box<S.Maybe<boolean>>>")[0])).toContain("S.Maybe<boolean>");
    expect(JSON.stringify(variants("S.Maybe<S.Box<S.Maybe<int32>>>")[0])).toContain("S.Maybe<int32>");
    const holder = find(ir, "S.Holder");
    if (holder.kind !== "model") throw new Error("expected model");
    expect(holder.properties.map((p) => p.type)).toEqual([
      { kind: "named", id: "S.Maybe<S.Maybe<int32>>" },
      { kind: "named", id: "S.Maybe<S.Maybe<boolean>>" },
      { kind: "named", id: "S.Maybe<S.Box<S.Maybe<int32>>>" },
      { kind: "named", id: "S.Maybe<S.Box<S.Maybe<boolean>>>" },
      { kind: "named", id: "S.Plain" },
    ]);
    expect(find(ir, "S.Plain")).toMatchObject({ kind: "union", name: "Plain" });

    const perInstance = await build(
      `
      @service namespace S;
      union Maybe<T> { T, string }
      model Box<T> { v: T }
      model Holder { c: Box<Maybe<int32>>; d: Box<Maybe<boolean>>; }
    `,
      { generics: false },
    );
    expect(find(perInstance, "S.Box<S.Maybe<int32>>")).toMatchObject({
      properties: [{ type: { kind: "named", id: "S.Maybe<int32>" } }],
    });
    expect(find(perInstance, "S.Box<S.Maybe<boolean>>")).toMatchObject({
      properties: [{ type: { kind: "named", id: "S.Maybe<boolean>" } }],
    });
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
