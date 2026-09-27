import { expectDiagnostics } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { emitter, HEADER } from "./tester.js";

const docSpec = `
  using TspGen;
  @service namespace S;
  /** A pet */
  model Pet { /** Its name */ name: string }
  /** An owner */
  @meta("typescript", #{ features: #{ docs: false } })
  model Owner { /** Owner name */ name: string }
`;

describe("typescript: header", () => {
  it("renders the default header", async () => {
    const { outputs } = await emitter().compile(docSpec);
    expect(outputs["models/Pet.ts"].startsWith(`${HEADER}\n\n/**`)).toBe(true);
  });

  it("renders no header with features.header false", async () => {
    const { outputs } = await emitter({ features: { header: false } }).compile(docSpec);
    expect(outputs["models/Pet.ts"].startsWith("/**\n * A pet\n */\n")).toBe(true);
  });

  it("renders a multi-line header-text as line comments", async () => {
    const { outputs } = await emitter({ "header-text": "@generated\n\nDo not edit." }).compile(docSpec);
    expect(outputs["models/Pet.ts"].startsWith("// @generated\n//\n// Do not edit.\n\n/**")).toBe(true);
  });

  it("treats header-text: \"\" as unset, rendering the default banner", async () => {
    const { outputs } = await emitter({ "header-text": "" }).compile(docSpec);
    expect(outputs["models/Pet.ts"].startsWith(`${HEADER}\n\n/**`)).toBe(true);
  });
});

describe("typescript: docs", () => {
  it("renders JSDoc by default and none for a declaration with features.docs false", async () => {
    const { outputs } = await emitter().compile(docSpec);
    expect(outputs["models/Pet.ts"]).toContain("/**\n * A pet\n */\n");
    expect(outputs["models/Owner.ts"]).not.toContain("An owner");
    expect(outputs["models/Owner.ts"]).not.toContain("Owner name");
  });

  it("renders no JSDoc with features.docs false", async () => {
    const { outputs } = await emitter({ features: { docs: false } }).compile(docSpec);
    expect(outputs["models/Pet.ts"]).not.toContain("A pet");
    expect(outputs["models/Pet.ts"]).not.toContain("Its name");
  });
});

describe("typescript: moved options", () => {
  it("rejects the moved generics option", async () => {
    const diagnostics = await emitter({ generics: false }).diagnose(`@service namespace S; model Pet { id: int64 }`);
    expectDiagnostics(diagnostics, {
      code: "@abhigyakrishna/tspgen-core/option-moved",
      message: "`generics` moved to `features.generics` in 0.2.0.",
    });
  });
});

describe("typescript: zod", () => {
  it("emits no schemas by default and schemas with features.zod", async () => {
    const spec = `@service namespace S; model Pet { name: string }`;
    expect((await emitter().compile(spec)).outputs["models/Pet.ts"]).not.toContain("PetSchema");
    expect((await emitter({ features: { zod: true } }).compile(spec)).outputs["models/Pet.ts"]).toContain(
      "export const PetSchema: z.ZodType<Pet> = z.object({",
    );
  });

  it("rejects the moved zod option", async () => {
    const diagnostics = await emitter({ zod: true }).diagnose(`@service namespace S; model Pet { id: int64 }`);
    expectDiagnostics(diagnostics, {
      code: "@abhigyakrishna/tspgen-core/option-moved",
      message: "`zod` moved to `features.zod` in 0.2.0.",
    });
  });
});

describe("typescript: barrel", () => {
  const spec = `@service namespace S; model Pet { name: string } model Owner { pet: Pet }`;

  it("emits models/index.ts by default and none with features.barrel false", async () => {
    expect((await emitter().compile(spec)).outputs["models/index.ts"]).toContain(`export * from "./Pet";`);
    const { outputs } = await emitter({ features: { barrel: false } }).compile(spec);
    expect(outputs["models/index.ts"]).toBeUndefined();
    expect(outputs["models/Pet.ts"]).toContain("export interface Pet {");
  });

  it("warns that barrel has no effect with the single-file layout only when set explicitly", async () => {
    const [, explicit] = await emitter({ layout: "single-file", features: { barrel: true } }).compileAndDiagnose(spec);
    expectDiagnostics(explicit, {
      code: "@abhigyakrishna/tspgen-core/unsupported-feature",
      severity: "warning",
      message: '`features.barrel` has no effect with layout "single-file".',
    });
    const [, byDefault] = await emitter({ layout: "single-file" }).compileAndDiagnose(spec);
    expect(byDefault).toEqual([]);
  });
});
