import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");

describe("README options reference", () => {
  it("matches `pnpm docs:options` (run it after changing an options schema or feature)", async () => {
    const script = await import(pathToFileURL(resolve(ROOT, "scripts/docs-options.mjs")).href);
    const readme = readFileSync(resolve(ROOT, "README.md"), "utf8");
    expect(readme).toBe(script.withOptionsReference(readme, await script.optionsReference()));
  });
});
