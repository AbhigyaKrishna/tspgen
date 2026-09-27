import { buildApiIR } from "@abhigyakrishna/tspgen-core";
import { describe, expect, it } from "vitest";
import { isJsonContentType, listOf, mapOf, nullable, scalarTypeUse, serializerExpr, serializerImports, type KtTypeUse } from "../src/index.js";
import { transformToKotlin, type KtOperation } from "../src/transform/index.js";
import { Tester } from "./tester.js";

async function ops(code: string, scalarStyle: "inline" | "typealias" | "value-class" = "inline"): Promise<Record<string, KtOperation>> {
  const [{ program }] = await Tester.compileAndDiagnose(code);
  const ir = transformToKotlin(program, buildApiIR(program), { package: "com.acme", scalarStyle } as never);
  return Object.fromEntries(ir.services.flatMap((s) => s.groups.flatMap((g) => g.operations)).map((op) => [op.name, op]));
}

const BIG_ID = `
  @service namespace S;
  @encode(string) scalar BigId extends int64;
  model Pet { id: BigId }
  @route("/list") op list(): BigId[];
  @route("/one") op one(): BigId;
  @route("/maybe") op maybe(@body id?: BigId): void;
  @route("/map") op map(): Record<BigId>;
  @route("/nested") op nested(): BigId[][];
  @route("/pets") op pets(): Pet[];
  @route("/take") op take(@body ids: BigId[]): void;
  @route("/plain") op plain(): int64[];
`;

describe("serializerExpr", () => {
  it("is undefined when nothing in the type needs a serializer", () => {
    expect(serializerExpr(scalarTypeUse("int64"))).toBeUndefined();
    expect(serializerExpr(listOf(scalarTypeUse("string")))).toBeUndefined();
    expect(serializerExpr(nullable(mapOf(scalarTypeUse("int32"))))).toBeUndefined();
    const pet: KtTypeUse = { text: "Pet", imports: ["com.acme.models.Pet"], nullable: false };
    expect(serializerExpr(listOf(pet))).toBeUndefined();
    expect(serializerImports(listOf(pet))).toEqual([]);
  });

  it("builds explicit serializers for @encode(string) scalars at the top level, in lists, maps and nullables", async () => {
    for (const style of ["inline", "typealias"] as const) {
      const o = await ops(BIG_ID, style);
      const ser = (name: string) => serializerExpr(o[name].result.type);
      expect(ser("one")).toBe("LongAsStringSerializer");
      expect(ser("list")).toBe("ListSerializer(LongAsStringSerializer)");
      expect(serializerExpr(o.maybe.body!.type)).toBe("LongAsStringSerializer.nullable");
      expect(ser("map")).toBe("MapSerializer(String.serializer(), LongAsStringSerializer)");
      expect(ser("nested")).toBe("ListSerializer(ListSerializer(LongAsStringSerializer))");
      expect(ser("pets")).toBeUndefined();
      expect(ser("plain")).toBeUndefined();
      expect(serializerExpr(o.take.body!.type)).toBe("ListSerializer(LongAsStringSerializer)");
      expect(serializerImports(o.map.result.type).sort()).toEqual([
        "kotlinx.serialization.builtins.LongAsStringSerializer",
        "kotlinx.serialization.builtins.MapSerializer",
        "kotlinx.serialization.builtins.serializer",
      ]);
      expect(serializerImports(o.maybe.body!.type).sort()).toEqual([
        "kotlinx.serialization.builtins.LongAsStringSerializer",
        "kotlinx.serialization.builtins.nullable",
      ]);
    }
  });

  it("uses nullable element serializers inside lists", async () => {
    const o = await ops(`
      @service namespace S;
      @encode(string) scalar BigId extends int64;
      @route("/list") op list(): (BigId | null)[];
    `);
    expect(serializerExpr(o.list.result.type)).toBe("ListSerializer(LongAsStringSerializer.nullable)");
  });

  it("uses the generated ULong and value-class serializers", async () => {
    const o = await ops(`
      @service namespace S;
      @encode(string) scalar Big extends uint64;
      scalar Count extends int64;
      @route("/big") op big(): Big[];
      @route("/raw") op raw(): Count[];
    `, "value-class");
    expect(serializerExpr(o.big.result.type)).toBeUndefined();
    expect(serializerExpr(o.raw.result.type)).toBeUndefined();
    const inline = await ops(`
      @service namespace S;
      @encode(string) scalar Big extends uint64;
      @route("/big") op big(): Big[];
    `);
    expect(serializerExpr(inline.big.result.type)).toBe("ListSerializer(ULongAsStringSerializer)");
    expect(serializerImports(inline.big.result.type)).toContain("com.acme.models.ULongAsStringSerializer");
  });

  it("honours @encode(string) on an explicit body property", async () => {
    const o = await ops(`
      @service namespace S;
      @route("/take") op take(@body @encode(string) id: int64): void;
    `);
    expect(serializerExpr(o.take.body!.type)).toBe("LongAsStringSerializer");
  });

  it("passes argument serializers to a generic model's serializer", async () => {
    const o = await ops(`
      @service namespace S;
      @encode(string) scalar BigId extends int64;
      model Page<T> { items: T[] }
      model Pet { name: string }
      @route("/ids") op ids(): Page<BigId>;
      @route("/pets") op pets(): Page<Pet>;
    `);
    expect(serializerExpr(o.ids.result.type)).toBe("Page.serializer(LongAsStringSerializer)");
    expect(serializerExpr(o.pets.result.type)).toBeUndefined();
  });

  it("tells JSON media types", () => {
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("application/merge-patch+json; charset=utf-8")).toBe(true);
    expect(isJsonContentType("text/plain")).toBe(false);
    expect(isJsonContentType("application/jsonl")).toBe(false);
  });
});
