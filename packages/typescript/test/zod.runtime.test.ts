import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { emitter } from "./tester.js";

// Inside this package so the generated `import { z } from "zod"` resolves from its node_modules.
const dir = mkdtempSync(join(resolve(import.meta.dirname, ".."), ".tmp-run-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("generated zod schemas (runtime)", () => {
  it("use .exactOptional(): an optional key may be absent but not present with value undefined", async () => {
    const { outputs } = await emitter({ features: { zod: true }, layout: "single-file" }).compile(`
      @service namespace S;
      model Req { name: string; note?: string }
    `);
    writeFileSync(join(dir, "types.ts"), outputs["types.ts"]);
    const { ReqSchema } = await import(pathToFileURL(join(dir, "types.ts")).href);

    expect(ReqSchema.safeParse({ name: "a" }).success).toBe(true);
    expect(ReqSchema.safeParse({ name: "a", note: "n" }).success).toBe(true);
    expect(ReqSchema.safeParse({ name: "a", note: undefined }).success).toBe(false);
  });
});
