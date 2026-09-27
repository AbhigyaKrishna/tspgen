import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { emitter } from "./tester.js";

const spec = `
  using TspGen;
  @service namespace S;
  model Owner { name: string }
  @meta("typescript", #{ readonly: true, supertypes: #[#{ name: "Owner", from: "./Owner" }], jsdoc: #["@public"] })
  model Pet {
    id: int64;
    @meta("typescript", #{ readonly: false, jsdoc: #["@internal"] }) note?: string;
  }
`;

describe("typescript @meta keys", () => {
  it("applies readonly, extends and jsdoc", async () => {
    const { outputs } = await emitter().compile(spec);
    expect(outputs["models/Pet.ts"]).toContain(`import type { Owner } from "./Owner";

/**
 * @public
 */
export interface Pet extends Owner {
  readonly id: number;
  /**
   * @internal
   */
  note?: string;
}`);
  });

  it("casts the zod schema of extended interfaces and type-checks", async () => {
    const { outputs } = await emitter({ zod: true }).compile(spec);
    expect(outputs["models/Pet.ts"]).toContain(`export const PetSchema = z.object({
  id: z.number().int(),
  note: z.string().exactOptional(),
}).loose() as unknown as z.ZodType<Pet>;`);
    const dir = mkdtempSync(join(resolve(import.meta.dirname, ".."), ".tmp-tsc-"));
    try {
      for (const [path, content] of Object.entries(outputs)) {
        if (!path.endsWith(".ts")) continue;
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
      }
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, module: "esnext", moduleResolution: "bundler", skipLibCheck: true, verbatimModuleSyntax: true },
          include: ["**/*.ts"],
        }),
      );
      const tsc = resolve(import.meta.dirname, "../../../node_modules/.bin/tsc");
      let out = "";
      try {
        out = execFileSync(tsc, ["-p", dir], { encoding: "utf8" });
      } catch (error) {
        out = String((error as { stdout?: string }).stdout ?? error);
      }
      expect(out).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
