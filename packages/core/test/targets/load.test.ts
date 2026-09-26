import { expectDiagnostics } from "@typespec/compiler/testing";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadTargets } from "../../src/index.js";
import { Tester } from "../tester.js";

const dir = mkdtempSync(join(tmpdir(), "specgen-targets-"));
writeFileSync(
  join(dir, "target.mjs"),
  `export default {
    name: "t", kind: "server", language: "kotlin",
    optionsSchema: {
      type: "object", additionalProperties: false,
      properties: { style: { type: "string", enum: ["a", "b"], default: "a" } },
    },
    files: () => [],
  };`,
);

describe("loadTargets", () => {
  it("loads targets and applies option defaults", async () => {
    const { program } = await Tester.compile(`model M {}`);
    const targets = await loadTargets(program, ["./target.mjs", { "./target.mjs": { style: "b" } }], dir, "kotlin");
    expect(targets?.map((t) => [t.target.name, t.options])).toEqual([
      ["t", { style: "a" }],
      ["t", { style: "b" }],
    ]);
  });

  it("reports invalid target options", async () => {
    const { program } = await Tester.compile(`model M {}`);
    const targets = await loadTargets(program, [{ "./target.mjs": { style: "c" } }], dir, "kotlin");
    expect(targets).toBeUndefined();
    expectDiagnostics(program.diagnostics, { code: "@specgen/emitter-core/invalid-target-options" });
  });

  it("rejects targets written for another language", async () => {
    const { program } = await Tester.compile(`model M {}`);
    const targets = await loadTargets(program, ["./target.mjs"], dir, "python");
    expect(targets).toBeUndefined();
    expectDiagnostics(program.diagnostics, {
      code: "@specgen/emitter-core/module-load-failed",
      message: /not 'python'/,
    });
  });
});
