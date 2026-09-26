import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ExtensionRegistry, loadModuleDefault } from "../../src/index.js";

describe("loadModuleDefault", () => {
  const dir = mkdtempSync(join(tmpdir(), "tspgen-load-"));
  writeFileSync(join(dir, "local.mjs"), `export default { name: "local" };`);
  writeFileSync(join(dir, "nodefault.mjs"), `export const x = 1;`);
  mkdirSync(join(dir, "node_modules", "fake-plugin"), { recursive: true });
  writeFileSync(
    join(dir, "node_modules", "fake-plugin", "package.json"),
    JSON.stringify({ name: "fake-plugin", type: "module", exports: { ".": "./index.js" } }),
  );
  writeFileSync(join(dir, "node_modules", "fake-plugin", "index.js"), `export default { name: "fake" };`);

  it("loads relative paths against the base dir", async () => {
    expect(await loadModuleDefault<{ name: string }>("./local.mjs", dir)).toEqual({ name: "local" });
  });

  it("loads bare package specifiers from the base dir's node_modules", async () => {
    expect(await loadModuleDefault<{ name: string }>("fake-plugin", dir)).toEqual({ name: "fake" });
  });

  it("rejects modules without a default export", async () => {
    await expect(loadModuleDefault("./nodefault.mjs", dir)).rejects.toThrow(/no default export/);
  });
});

// Vitest compiles TypeScript itself, so these run the built loader under plain Node, as `tsp compile` does.
describe("loadModuleDefault with TypeScript under Node", () => {
  const dir = mkdtempSync(join(tmpdir(), "tspgen-load-ts-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(dir, "names.ts"), `export const NAME: string = "typed";\n`);
  writeFileSync(
    join(dir, "plugin.ts"),
    `import type { TspGenPlugin } from "@abhigyakrishna/tspgen-core";\n` +
      `import { NAME } from "./names.ts";\n` +
      `interface Extra { note?: string }\n` +
      `const plugin: TspGenPlugin & Extra = { name: NAME };\n` +
      `export default plugin;\n`,
  );
  writeFileSync(join(dir, "enum.mts"), `enum Kind { A }\nexport default { name: String(Kind.A) };\n`);
  const loader = pathToFileURL(fileURLToPath(new URL("../../dist/loader.js", import.meta.url))).href;

  function load(specifier: string): string {
    const script =
      `const { loadModuleDefault } = await import(${JSON.stringify(loader)});` +
      `try { console.log((await loadModuleDefault(${JSON.stringify(specifier)}, ${JSON.stringify(dir)})).name); }` +
      `catch (e) { console.log("error: " + e.message); }`;
    return execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }).trim();
  }

  it("loads type-annotated modules, including relative .ts imports", () => {
    expect(load("./plugin.ts")).toBe("typed");
  });

  it("explains syntax Node cannot strip", () => {
    expect(load("./enum.mts")).toMatch(/^error: '\.\/enum\.mts' uses TypeScript syntax that Node cannot strip.*erasableSyntaxOnly/);
  });
});

describe("ExtensionRegistry", () => {
  it("registers and looks up implementations by kind and name", () => {
    const registry = new ExtensionRegistry();
    registry.register("ktor-server.routing-style", "custom", { id: 1 });
    expect(registry.get("ktor-server.routing-style", "custom")).toEqual({ id: 1 });
    expect(registry.get("ktor-server.routing-style", "missing")).toBeUndefined();
    expect(registry.names("ktor-server.routing-style")).toEqual(["custom"]);
  });
});
