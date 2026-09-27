import { expectDiagnostics } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { emitter } from "./tester.js";

describe("features.readonly", () => {
  it("is off by default", async () => {
    const { outputs } = await emitter().compile(`@service namespace S; model Pet { id: int64 }`);
    expect(outputs["models/Pet.ts"]).toContain("export interface Pet {\n  id: number;\n}");
  });

  it("makes every property readonly; property meta wins; arrays and zod unchanged", async () => {
    const { outputs } = await emitter({ features: { readonly: true, zod: true } }).compile(`
      using TspGen;
      @service namespace S;
      model Pet {
        id: int64;
        tags: string[];
        @meta("typescript", #{ readonly: false }) note?: string;
      }
    `);
    expect(outputs["models/Pet.ts"]).toContain(`export interface Pet {
  readonly id: number;
  readonly tags: string[];
  note?: string;
}

export const PetSchema: z.ZodType<Pet> = z.object({
  id: z.number().int(),
  tags: z.array(z.string()),
  note: z.string().exactOptional(),
});`);
  });

  it("is overridden per model and per namespace with @meta features", async () => {
    const { outputs } = await emitter().compile(`
      using TspGen;
      @service namespace S;
      @meta("typescript", #{ features: #{ readonly: true } }) model Pet { id: int64 }
      model Owner { name: string }
      @meta("typescript", #{ features: #{ readonly: true } })
      namespace Frozen {
        model Snapshot { at: string }
        @meta("typescript", #{ features: #{ readonly: false } }) model Draft { at: string }
      }
    `);
    expect(outputs["models/Pet.ts"]).toContain("  readonly id: number;");
    expect(outputs["models/Owner.ts"]).toContain("  name: string;");
    expect(outputs["models/Snapshot.ts"]).toContain("  readonly at: string;");
    expect(outputs["models/Draft.ts"]).toContain("export interface Draft {\n  at: string;\n}");
  });

  it("reports the model-level readonly meta as moved and ignores it", async () => {
    const [result, diagnostics] = await emitter().compileAndDiagnose(`
      using TspGen;
      @service namespace S;
      @meta("typescript", #{ readonly: true }) model Pet { id: int64 }
    `);
    expectDiagnostics(diagnostics, {
      code: "@abhigyakrishna/tspgen-core/invalid-meta",
      message: "Metadata key 'readonly' on 'S.Pet' must be moved to features: #{ readonly } in 0.2.0; it is ignored.",
    });
    expect(result.outputs["models/Pet.ts"]).toContain("  id: number;");
  });

  it("reports the model-level readonly meta as moved even for a discriminator base model (an alias, not an interface)", async () => {
    const [, diagnostics] = await emitter().compileAndDiagnose(`
      using TspGen;
      @service namespace S;
      @discriminator("kind") @meta("typescript", #{ readonly: true }) model Pet { kind: string }
      model Dog extends Pet { kind: "dog" }
    `);
    expectDiagnostics(diagnostics, {
      code: "@abhigyakrishna/tspgen-core/invalid-meta",
      message: "Metadata key 'readonly' on 'S.Pet' must be moved to features: #{ readonly } in 0.2.0; it is ignored.",
    });
  });
});
