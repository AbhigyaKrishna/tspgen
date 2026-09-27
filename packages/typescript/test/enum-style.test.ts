import { expectDiagnostics } from "@typespec/compiler/testing";
import { afterAll, describe, expect, it } from "vitest";
import { emitter } from "./tester.js";
import { cleanup, load, tsc } from "./tsc.js";

afterAll(cleanup);

const spec = `
  @service namespace S;
  enum PetKind { dog, cat }
  enum Level { low: 1, high: 2 }
  union Size { "s", "m" }
  model Pet { kind: PetKind; level: Level; size: Size }
`;

function emit(style?: string) {
  return emitter({ features: { zod: true }, ...(style ? { "enum-style": style } : {}) }).compile(spec);
}

describe("enum-style", () => {
  it("union-const (default) keeps the literal union plus const object", async () => {
    const { outputs } = await emit();
    expect(outputs["models/PetKind.ts"]).toContain(`export type PetKind = "dog" | "cat";

export const PetKind = {
  Dog: "dog",
  Cat: "cat",
} as const;

export const PetKindSchema: z.ZodType<PetKind> = z.enum(["dog", "cat"]);`);
    expect(outputs["models/Level.ts"]).toContain(`export const LevelSchema: z.ZodType<Level> = z.union([z.literal(1), z.literal(2)]);`);
  });

  it("union emits the type only", async () => {
    const { outputs } = await emit("union");
    expect(outputs["models/PetKind.ts"]).toContain(`export type PetKind = "dog" | "cat";

export const PetKindSchema: z.ZodType<PetKind> = z.enum(["dog", "cat"]);`);
    expect(outputs["models/PetKind.ts"]).not.toContain("export const PetKind =");
    expect(outputs["models/Size.ts"]).toContain(`export type Size = "s" | "m";`);
    expect(tsc(outputs)).toBe("");
  });

  it("enum emits a TypeScript enum validated with z.enum(<enum>)", async () => {
    const { outputs } = await emit("enum");
    expect(outputs["models/PetKind.ts"]).toContain(`export enum PetKind {
  Dog = "dog",
  Cat = "cat",
}

export const PetKindSchema: z.ZodType<PetKind> = z.enum(PetKind);`);
    expect(outputs["models/Level.ts"]).toContain(`export enum Level {
  Low = 1,
  High = 2,
}`);
    expect(outputs["models/Size.ts"]).toContain(`export enum Size {
  S = "s",
  M = "m",
}`);
    expect(tsc(outputs)).toBe("");
    const { PetKindSchema, PetKind } = await load(outputs, "models/PetKind.ts");
    expect(PetKindSchema.parse("cat")).toBe(PetKind.Cat);
    expect(PetKindSchema.safeParse("cow").success).toBe(false);
  });

  it("const-array emits <Name>Values and derives the type", async () => {
    const { outputs } = await emit("const-array");
    expect(outputs["models/PetKind.ts"]).toContain(`export const PetKindValues = ["dog", "cat"] as const;

export type PetKind = (typeof PetKindValues)[number];

export const PetKindSchema: z.ZodType<PetKind> = z.enum(PetKindValues);`);
    expect(outputs["models/Level.ts"]).toContain(`export const LevelValues = [1, 2] as const;

export type Level = (typeof LevelValues)[number];

export const LevelSchema: z.ZodType<Level> = z.union([z.literal(1), z.literal(2)]);`);
    expect(outputs["models/Size.ts"]).toContain(`export const SizeValues = ["s", "m"] as const;`);
    expect(tsc(outputs)).toBe("");
  });

  it("the values meta renames the const-array tuple", async () => {
    const { outputs } = await emitter({ "enum-style": "const-array" }).compile(`
      using TspGen;
      @service namespace S;
      @meta("typescript", #{ values: "KINDS" }) enum PetKind { dog, cat }
    `);
    expect(outputs["models/PetKind.ts"]).toContain(`export const KINDS = ["dog", "cat"] as const;

export type PetKind = (typeof KINDS)[number];`);
  });

  it("the enumStyle meta overrides the option per declaration", async () => {
    const { outputs } = await emitter().compile(`
      using TspGen;
      @service namespace S;
      @meta("typescript", #{ enumStyle: "enum" }) enum PetKind { dog, cat }
      enum Other { a, b }
    `);
    expect(outputs["models/PetKind.ts"]).toContain("export enum PetKind {");
    expect(outputs["models/Other.ts"]).toContain(`export type Other = "a" | "b";\n\nexport const Other = {`);
  });

  it("reports an invalid enumStyle meta and keeps the option", async () => {
    const [result, diagnostics] = await emitter().compileAndDiagnose(`
      using TspGen;
      @service namespace S;
      @meta("typescript", #{ enumStyle: "tuple" }) enum PetKind { dog, cat }
    `);
    expectDiagnostics(diagnostics, {
      code: "@abhigyakrishna/tspgen-core/invalid-meta",
      message: `Metadata key 'enumStyle' on 'S.PetKind' must be one of "union-const", "union", "enum", "const-array"; it is ignored.`,
    });
    expect(result.outputs["models/PetKind.ts"]).toContain(`export const PetKind = {`);
  });

  it("reports a tuple named like another generated type", async () => {
    const [, diagnostics] = await emitter({ "enum-style": "const-array" }).compileAndDiagnose(`
      @service namespace S;
      enum PetKind { dog, cat }
      model PetKindValues { n: int32 }
    `);
    expectDiagnostics(diagnostics, {
      code: "@abhigyakrishna/tspgen-typescript/duplicate-type-name",
      message: /TypeScript type 'PetKindValues' is generated from both/,
    });
  });
});
