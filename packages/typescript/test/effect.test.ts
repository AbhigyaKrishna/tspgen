import { Schema } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { emitter } from "./tester.js";
import { cleanup, load, tsc } from "./tsc.js";

afterAll(cleanup);

const spec = `
  using TspGen;
  @service namespace Shop;
  enum Status { active, closed }
  enum Code { ok: 1, error: 2 }
  model Page<T> { items: T[]; next?: Page<T> }
  model Node {
    @minLength(2) @pattern("^[a-z]+$") name: string;
    @minValue(1) @maxValue(10) count: int32;
    @minItems(1) tags: string[];
    parent?: Node | null;
    children: Record<Node>;
    status: Status;
    code: Code;
  }
  union Value { node: Node, text: string, number: int32 }
  model Response { page: Page<Node>; value: Value }
`;

describe("Effect schemas", () => {
  it("is opt-in and independent of Zod", async () => {
    const plain = await emitter().compile(spec);
    expect(Object.values(plain.outputs).join("\n")).not.toContain('from "effect"');
    const { outputs } = await emitter({ features: { effect: true } }).compile(spec);
    expect(outputs["models/Node.ts"]).toContain("NodeEffectSchema");
    expect(Object.values(outputs).join("\n")).not.toContain('from "zod"');
    expect(tsc(outputs, { exactOptionalPropertyTypes: true })).toBe("");
  });

  it.each(["per-type", "single-file"])(
    "compiles recursive generics, unions and enums in %s alongside Zod",
    async (layout) => {
      const { outputs } = await emitter({
        layout,
        "import-extension": ".js",
        features: { effect: true, zod: true },
      }).compile(spec);
      expect(tsc(outputs, { exactOptionalPropertyTypes: true })).toBe("");
    },
  );

  it.each(["union", "union-const", "enum", "const-array"])("supports %s enums", async (style) => {
    const { outputs } = await emitter({ "enum-style": style, features: { effect: true } }).compile(spec);
    expect(tsc(outputs, { exactOptionalPropertyTypes: true })).toBe("");
  });

  it("decodes recursion and applies exact optional properties and constraints", async () => {
    const { outputs } = await emitter({ features: { effect: true } }).compile(spec);
    const { NodeEffectSchema, ResponseEffectSchema } = await load(outputs, "models/index.ts");
    const decode = Schema.decodeUnknownSync(NodeEffectSchema);
    const node = { name: "root", count: 2, tags: ["a"], status: "active", code: 1, children: {} };
    expect(decode({ ...node, parent: { ...node, parent: null }, children: { first: node } })).toMatchObject(node);
    expect(
      Schema.decodeUnknownSync(ResponseEffectSchema)({ page: { items: [node], next: { items: [] } }, value: node }),
    ).toMatchObject({ value: node });
    for (const change of [
      { name: "a" },
      { name: "AB" },
      { count: 0 },
      { count: 11 },
      { count: 1.5 },
      { tags: [] },
      { status: "missing" },
      { code: 3 },
      { parent: undefined },
    ]) {
      expect(() => decode({ ...node, ...change })).toThrow();
    }
  });

  it("checks nullable constraints, encoded integers and decimals without losing precision", async () => {
    const { outputs } = await emitter({ features: { effect: true }, layout: "single-file" }).compile(`
      @service namespace S;
      model Values {
        @minLength(2) note: string | null;
        @encode(string) @minValue(9007199254740992) id: int64;
        @encode(string) unsigned: uint64;
        price: decimal;
      }
    `);
    expect(tsc(outputs)).toBe("");
    const { ValuesEffectSchema } = await load(outputs, "types.ts");
    const decode = Schema.decodeUnknownSync(ValuesEffectSchema);
    const value = { note: null, id: "9007199254740993", unsigned: "2", price: "1.23e-10" };
    expect(decode(value)).toEqual(value);
    for (const change of [
      { note: "a" },
      { id: "9007199254740991" },
      { id: "abc" },
      { unsigned: "-1" },
      { price: "abc" },
    ]) {
      expect(() => decode({ ...value, ...change })).toThrow();
    }
  });

  it("decodes and encodes Date values alongside the existing Zod codecs", async () => {
    const { outputs } = await emitter({ features: { effect: true, zod: true }, "date-type": "date" }).compile(`
      @service namespace S;
      model Meeting { at: utcDateTime; dates: utcDateTime[] }
    `);
    expect(tsc(outputs, { exactOptionalPropertyTypes: true })).toBe("");
    const { MeetingEffectSchema } = await load(outputs, "models/index.ts");
    const at = "2026-10-14T00:00:00.000Z";
    const decoded = Schema.decodeUnknownSync(MeetingEffectSchema)({ at, dates: [at] });
    expect(decoded).toEqual({ at: new Date(at), dates: [new Date(at)] });
    expect(Schema.encodeSync(MeetingEffectSchema)(decoded)).toEqual({ at, dates: [at] });
  });

  it("reports schema export and import name collisions", async () => {
    for (const models of ["model Pet {} model PetEffectSchema {}", "model Schema {}"]) {
      const diagnostics = await emitter({ features: { effect: true } }).diagnose(`@service namespace S; ${models}`);
      expect(diagnostics.some((d) => d.code === "@abhigyakrishna/tspgen-typescript/duplicate-type-name")).toBe(true);
    }
  });

  it("preserves external supertype fields and opaque type mappings", async () => {
    const { outputs } = await emitter({ features: { effect: true }, layout: "single-file" }).compile(`
      using TspGen;
      @service namespace Shop;
      @TS.type("Token", "./external") scalar Token extends string;
      @meta("typescript", #{ supertypes: #[#{ name: "External", from: "./external" }] })
      model Pet { token: Token; name: string }
    `);
    outputs["external.ts"] =
      "export interface External { extra: string }\nexport type Token = string & { token: true };\n";
    expect(tsc(outputs)).toBe("");
    const { PetEffectSchema } = await load(outputs, "types.ts");
    expect(Schema.decodeUnknownSync(PetEffectSchema)({ name: "Rex", token: "opaque", extra: "kept" })).toEqual({
      name: "Rex",
      token: "opaque",
      extra: "kept",
    });
  });
});
