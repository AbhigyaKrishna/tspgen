import { expectDiagnostics } from "@typespec/compiler/testing";
import { afterAll, describe, expect, it } from "vitest";
import { emitter } from "./tester.js";
import { cleanup, load, tsc } from "./tsc.js";

afterAll(cleanup);

// @pattern/@minLength/@maxLength require a string-assignable property type at the TypeSpec compiler level
// (checked via isStringType), so they cannot target decimal128 even with @encode(string). The notBlank meta
// flag isn't compiler-validated this way, so it stands in here to exercise the same "any z.string()… base"
// refinement path (constraints.ts) for a decimal.
const spec = `
  using TspGen;
  @service namespace S;
  @encode(string) scalar BigId extends int64;
  model M {
    @encode(string) id: int64;
    ids: BigId[];
    count: int64;
    amount: decimal;
    @meta("*", #{ notBlank: true }) price: decimal128;
  }
`;

describe("@encode(string) and decimals", () => {
  it("types string-encoded integers as strings and checks decimal strings", async () => {
    const { outputs } = await emitter({ features: { zod: true }, layout: "single-file" }).compile(spec);
    const types = outputs["types.ts"];
    expect(types).toContain(`export interface M {
  id: string;
  ids: string[];
  count: number;
  amount: string;
  price: string;
}`);
    expect(types).toContain(`export const MSchema: z.ZodType<M> = z.object({
  id: z.string().regex(/^-?\\d+$/),
  ids: z.array(z.string().regex(/^-?\\d+$/)),
  count: z.number().int(),
  amount: z.string().regex(/^-?\\d+(\\.\\d+)?([eE][+-]?\\d+)?$/),
  price: z.string().regex(/^-?\\d+(\\.\\d+)?([eE][+-]?\\d+)?$/).regex(/\\S/, "must not be blank"),
});`);
    expect(tsc(outputs)).toBe("");
  });

  it("rejects non-numeric strings at runtime", async () => {
    const { outputs } = await emitter({ features: { zod: true }, layout: "single-file" }).compile(spec);
    const { MSchema } = await load(outputs, "types.ts");
    const valid = { id: "-9007199254740993", ids: ["1"], count: 1, amount: "12.50", price: "1e3" };
    expect(MSchema.safeParse(valid).success).toBe(true);
    expect(MSchema.safeParse({ ...valid, id: "12a" }).success).toBe(false);
    expect(MSchema.safeParse({ ...valid, amount: "twelve" }).success).toBe(false);
  });

  it("checks @minValue/@maxValue on @encode(string) integers with BigInt, and disallows a leading '-' for uint64", async () => {
    const { outputs } = await emitter({ features: { zod: true }, layout: "single-file" }).compile(`
      using TspGen;
      @service namespace S;
      model M {
        @minValue(1) @maxValue(100) @encode(string) id: int64;
        @encode(string) big: uint64;
      }
    `);
    const types = outputs["types.ts"];
    expect(types).toContain("  id: z.string().regex(/^-?\\d+$/).refine((v) => BigInt(v) >= 1n).refine((v) => BigInt(v) <= 100n),");
    expect(types).toContain("  big: z.string().regex(/^\\d+$/),");
    expect(tsc(outputs)).toBe("");
    const { MSchema } = await load(outputs, "types.ts");
    expect(MSchema.safeParse({ id: "50", big: "5" }).success).toBe(true);
    expect(MSchema.safeParse({ id: "0", big: "5" }).success).toBe(false);
    expect(MSchema.safeParse({ id: "101", big: "5" }).success).toBe(false);
    expect(MSchema.safeParse({ id: "50", big: "-5" }).success).toBe(false);
  });

  it("warns and does not check @minValue/@maxValue on a decimal (always represented as a string)", async () => {
    const [result, diagnostics] = await emitter({ features: { zod: true } }).compileAndDiagnose(`
      @service namespace S;
      model M { @minValue(0) amount: decimal }
    `);
    expectDiagnostics(diagnostics, {
      code: "@abhigyakrishna/tspgen-typescript/unsupported-bounds",
      message: "@minValue/@maxValue on 'S.M.amount' has no effect: it is a decimal, represented as a string, and the bound is not checked.",
    });
    expect(result.outputs["models/M.ts"]).toContain("  amount: z.string().regex(/^-?\\d+(\\.\\d+)?([eE][+-]?\\d+)?$/),");
  });
});
