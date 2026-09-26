import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("ExtensionRegistry", () => {
  it("registers and looks up implementations by kind and name", () => {
    const registry = new ExtensionRegistry();
    registry.register("ktor-server.routing-style", "custom", { id: 1 });
    expect(registry.get("ktor-server.routing-style", "custom")).toEqual({ id: 1 });
    expect(registry.get("ktor-server.routing-style", "missing")).toBeUndefined();
    expect(registry.names("ktor-server.routing-style")).toEqual(["custom"]);
  });
});
