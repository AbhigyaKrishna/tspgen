import { buildApiIR } from "@abhigyakrishna/tspgen-core";
import { expectDiagnostics } from "@typespec/compiler/testing";
import { afterAll, describe, expect, it } from "vitest";
import { transformToTs, type TsDecl, type TsIR } from "../src/transform/index.js";
import { emitter, Tester } from "./tester.js";
import { cleanup, load, tsc } from "./tsc.js";

afterAll(cleanup);

const spec = `
  @service namespace S;
  model Pet {
    born: utcDateTime;
    at?: offsetDateTime;
    day: plainDate;
    visits: utcDateTime[];
    owner?: Owner;
  }
  model Owner { since: utcDateTime | null }
  model Plain { name: string }
`;

const dates = { features: { zod: true }, "date-type": "date" };

function decl(ir: TsIR, name: string): TsDecl {
  const found = ir.declarations.find((d) => d.name === name);
  if (!found) throw new Error(`no declaration ${name}`);
  return found;
}

describe("date-type: date", () => {
  it("maps utcDateTime to Date through dateTimeCodec in models/codecs.ts", async () => {
    const { outputs } = await emitter(dates).compile(spec);
    const pet = outputs["models/Pet.ts"];
    expect(pet).toContain(`import { dateTimeCodec } from "./codecs";`);
    expect(pet).toContain(`export interface Pet {
  born: globalThis.Date;
  at?: string;
  day: string;
  visits: globalThis.Date[];
  owner?: Owner;
}

export const PetSchema: z.ZodType<Pet> = z.object({
  born: dateTimeCodec,
  at: z.iso.datetime({ offset: true }).exactOptional(),
  day: z.iso.date(),
  visits: z.array(dateTimeCodec),
  owner: z.lazy(() => OwnerSchema).exactOptional(),
});`);
    expect(outputs["models/Owner.ts"]).toContain("  since: globalThis.Date | null;");
    expect(outputs["models/Owner.ts"]).toContain("  since: dateTimeCodec.nullable(),");
    expect(outputs["models/codecs.ts"]).toContain(`import { z } from "zod";

/** \`utcDateTime\` as a \`Date\`: \`parse\` decodes the ISO-8601 wire string, \`z.encode\` writes \`toISOString()\`. */
export const dateTimeCodec = z.codec(z.iso.datetime({ offset: true }), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString(),
});`);
    expect(outputs["models/index.ts"]).not.toContain("codecs");
    expect(tsc(outputs)).toBe("");
  });

  it("emits no codec file when no Date is used, and strings with the default date-type", async () => {
    const plain = await emitter(dates).compile(`@service namespace S; model Plain { name: string }`);
    expect(plain.outputs["models/codecs.ts"]).toBeUndefined();
    const strings = await emitter({ features: { zod: true } }).compile(spec);
    expect(strings.outputs["models/codecs.ts"]).toBeUndefined();
    expect(strings.outputs["models/Pet.ts"]).toContain("  born: string;");
  });

  it("declares the codec first in the single-file layout", async () => {
    const { outputs } = await emitter({ ...dates, layout: "single-file" }).compile(spec);
    const types = outputs["types.ts"];
    expect(types).not.toContain('from "./codecs"');
    expect(types.indexOf("export const dateTimeCodec")).toBeGreaterThan(0);
    expect(types.indexOf("export const dateTimeCodec")).toBeLessThan(types.indexOf("export const OwnerSchema"));
    expect(tsc(outputs)).toBe("");
  });

  it("decodes wire strings and encodes Dates at runtime", async () => {
    const { outputs } = await emitter({ ...dates, layout: "single-file" }).compile(spec);
    const { PetSchema } = await load(outputs, "types.ts");
    const wire = { born: "2026-09-27T10:00:00Z", day: "2026-09-27", visits: ["2026-09-28T08:30:00+02:00"] };
    const pet = PetSchema.parse(wire);
    expect(pet.born).toBeInstanceOf(Date);
    expect(pet.born.toISOString()).toBe("2026-09-27T10:00:00.000Z");
    expect(pet.visits[0].toISOString()).toBe("2026-09-28T06:30:00.000Z");
    expect(PetSchema.encode(pet)).toEqual({
      born: "2026-09-27T10:00:00.000Z",
      day: "2026-09-27",
      visits: ["2026-09-28T06:30:00.000Z"],
    });
    expect(PetSchema.safeParse({ ...wire, born: "yesterday" }).success).toBe(false);
  });

  it("flags codec uses through arrays, maps, nullables, unions, inline and generic models", async () => {
    const [{ program }] = await Tester.compileAndDiagnose(`
      @service namespace S;
      model Pet { born: utcDateTime }
      model Page<T> { items: T[] }
      model Box {
        pets: Pet[];
        byName: Record<Pet>;
        maybe: Pet | null;
        either: Pet | string;
        inline: { at: utcDateTime };
        page: Page<Pet>;
        plain: string;
        @TS.type("Date") raw: utcDateTime;
      }
      model Plain { n: int32 }
      @route("/pets") op list(@query after?: utcDateTime): Pet[];
    `);
    const ir = transformToTs(program, buildApiIR(program), { zod: true, importExtension: "", dateType: "date" });
    const box = decl(ir, "Box");
    if (box.kind !== "interface") throw new Error("expected interface");
    expect(box.properties.map((p) => [p.key, p.type.codec === true])).toEqual([
      ["pets", true],
      ["byName", true],
      ["maybe", true],
      ["either", true],
      ["inline", true],
      ["page", true],
      ["plain", false],
      ["raw", false],
    ]);
    const [op] = ir.services[0].groups[0].operations;
    expect(op.params[0].type).toMatchObject({ text: "globalThis.Date", schema: "dateTimeCodec", codec: true, date: true });
    expect(op.result.type.codec).toBe(true);
    expect(ir.dateType).toBe("date");
    expect(ir.codecsFile).toBe("models/codecs");
  });

  it("a model literally named Date does not shadow the global Date dateUse references", async () => {
    const { outputs } = await emitter({ ...dates, layout: "single-file" }).compile(`
      @service namespace S;
      model Date { x: int32 }
      model M { at: utcDateTime; d: Date }
      @route("/m") op get(@query at: utcDateTime): M;
    `);
    expect(outputs["types.ts"]).toContain("  at: globalThis.Date;");
    expect(outputs["types.ts"]).toContain("export interface Date {\n  x: number;\n}");
    expect(tsc(outputs)).toBe("");
  });

  it("warns and keeps strings without features.zod", async () => {
    const [result, diagnostics] = await emitter({ "date-type": "date" }).compileAndDiagnose(spec);
    expectDiagnostics(diagnostics, {
      code: "@abhigyakrishna/tspgen-core/unsupported-feature",
      message: "`date-type: date` has no effect without features.zod; dates stay strings.",
    });
    expect(result.outputs["models/Pet.ts"]).toContain("  born: string;");
    expect(result.outputs["models/codecs.ts"]).toBeUndefined();
  });
});
