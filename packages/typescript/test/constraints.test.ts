import { describe, expect, it } from "vitest";
import { constrain } from "../src/transform/constraints.js";
import { arrayOf, nullable, scalarUse } from "../src/transform/type-map.js";

const schema = (...args: Parameters<typeof constrain>) => constrain(...args).schema;

describe("constrain", () => {
  it("adds string refinements, notBlank first", () => {
    expect(schema(scalarUse("string"), { minLength: 2, maxLength: 5, pattern: "^[a-z]+$" }, true)).toBe(
      `z.string().regex(/\\S/, "must not be blank").min(2).max(5).regex(new RegExp("^[a-z]+$", "u"))`,
    );
  });

  it("compiles @pattern with the u flag when valid, else without flags, else skips it", () => {
    const invalid: string[] = [];
    const onInvalid = (p: string) => invalid.push(p);
    expect(schema(scalarUse("string"), { pattern: "^\\p{L}+$" }, false, onInvalid)).toBe(`z.string().regex(new RegExp("^\\\\p{L}+$", "u"))`);
    expect(schema(scalarUse("string"), { pattern: "^a\\-b$" }, false, onInvalid)).toBe(`z.string().regex(new RegExp("^a\\\\-b$"))`);
    expect(schema(scalarUse("string"), { pattern: "(?i)abc", maxLength: 3 }, false, onInvalid)).toBe("z.string().max(3)");
    expect(invalid).toEqual(["(?i)abc"]);
  });

  it("adds number bounds to ints and floats", () => {
    expect(schema(scalarUse("int32"), { minValue: 1, maxValue: 100 })).toBe("z.number().int().gte(1).lte(100)");
    expect(schema(scalarUse("float64"), { minValue: 0.5 })).toBe("z.number().gte(0.5)");
  });

  it("adds item bounds to arrays", () => {
    expect(schema(arrayOf(scalarUse("string")), { minItems: 1, maxItems: 3 })).toBe("z.array(z.string()).min(1).max(3)");
  });

  it("refines before .nullable()", () => {
    expect(schema(nullable(scalarUse("string")), { maxLength: 4 })).toBe("z.string().max(4).nullable()");
  });

  it("ignores constraints that do not fit the base schema", () => {
    expect(schema(scalarUse("int32"), { maxLength: 4 })).toBe("z.number().int()");
    expect(schema(scalarUse("utcDateTime"), { maxLength: 4 }, true)).toBe("z.iso.datetime({ offset: true })");
    expect(schema(scalarUse("string"), undefined)).toBe("z.string()");
  });

  it("leaves text and imports unchanged", () => {
    const base = scalarUse("string");
    expect(constrain(base, { minLength: 1 })).toMatchObject({ text: "string", imports: [], schemaImports: [] });
  });
});
