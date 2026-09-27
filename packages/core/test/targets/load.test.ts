import { expectDiagnostics } from "@typespec/compiler/testing";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadTargets, resolveOutputDir } from "../../src/index.js";
import { Tester } from "../tester.js";

const dir = mkdtempSync(join(tmpdir(), "tspgen-targets-"));
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
// A minimal, standalone stand-in for `defineFeatures` (see `src/features.ts`), so these fixture modules don't need
// a build of this package to exist (they are plain files dynamically imported at test time, resolved from `dir`,
// not compiled by our tsconfig): enough shape (`schema`, `resolve()` with `.values`/`.explicit`) for `loadTargets`.
writeFileSync(
  join(dir, "shared-features.mjs"),
  `export function defineFeatures(defs) {
    const properties = Object.fromEntries(
      Object.entries(defs).map(([key, def]) => [key, { type: "boolean", default: def.default, description: def.description }]),
    );
    return {
      defs,
      schema: { type: "object", additionalProperties: false, default: {}, properties },
      openSchema: { type: "object", nullable: true, additionalProperties: true, properties },
      resolve(configured) {
        const values = {};
        const explicit = new Set();
        const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
        for (const key of Object.keys(defs)) {
          const value = isRecord(configured) ? configured[key] : undefined;
          if (typeof value === "boolean") {
            values[key] = value;
            explicit.add(key);
          } else {
            values[key] = defs[key].default;
          }
        }
        return { defs, values, explicit, at: (key) => values[key] ?? false };
      },
    };
  }`,
);
writeFileSync(
  join(dir, "featured.mjs"),
  `import { defineFeatures } from "./shared-features.mjs";
  export default {
    name: "f", kind: "server", language: "kotlin",
    optionsSchema: { type: "object", additionalProperties: false, properties: { style: { type: "string", default: "a" } } },
    movedOptions: { module: "features.module" },
    features: defineFeatures({
      module: { default: true, description: "m" },
      extra: { default: false, description: "e" },
    }),
    files: () => [],
  };`,
);
// A target whose `optionsSchema` declares `$id`: ajv registers schemas by `$id`, so `loadTargets` must reuse the
// same merged-schema object across calls for this target, not build a fresh one each time (see `targetSchema` in
// `../../src/targets/load.ts`), or the second `validateOptions` call throws "schema with key or id already exists".
writeFileSync(
  join(dir, "id-schema.mjs"),
  `import { defineFeatures } from "./shared-features.mjs";
  export default {
    name: "g", kind: "server", language: "kotlin",
    optionsSchema: {
      $id: "tspgen-test-id-schema", type: "object", additionalProperties: false,
      properties: { style: { type: "string", default: "a" } },
    },
    features: defineFeatures({ extra: { default: false, description: "e" } }),
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

  it("takes output-dir out of the target's options", async () => {
    const { program } = await Tester.compile(`model M {}`);
    const targets = await loadTargets(program, [{ "./target.mjs": { style: "b", "output-dir": "gen/server" } }], dir, "kotlin");
    expect(targets?.map((t) => [t.options, t.outputDir])).toEqual([[{ style: "b" }, "gen/server"]]);
  });

  it("reports invalid target options", async () => {
    const { program } = await Tester.compile(`model M {}`);
    const targets = await loadTargets(program, [{ "./target.mjs": { style: "c" } }], dir, "kotlin");
    expect(targets).toBeUndefined();
    expectDiagnostics(program.diagnostics, { code: "@abhigyakrishna/tspgen-core/invalid-target-options" });
  });

  it("rejects targets written for another language", async () => {
    const { program } = await Tester.compile(`model M {}`);
    const targets = await loadTargets(program, ["./target.mjs"], dir, "python");
    expect(targets).toBeUndefined();
    expectDiagnostics(program.diagnostics, {
      code: "@abhigyakrishna/tspgen-core/module-load-failed",
      message: /not 'python'/,
    });
  });

  it("merges target features into the options schema, fills their defaults and resolves them", async () => {
    const { program } = await Tester.compile(`model M {}`);
    const targets = await loadTargets(program, [{ "./featured.mjs": { features: { extra: true } } }], dir, "kotlin");
    expect(program.diagnostics).toEqual([]);
    expect(targets?.[0]?.options).toEqual({ style: "a", features: { module: true, extra: true } });
    expect(targets?.[0]?.features?.values).toEqual({ module: true, extra: true });
    expect([...(targets?.[0]?.features?.explicit ?? [])]).toEqual(["extra"]);
  });

  it("a featured target configured without `features` gets defaults and an empty explicit set", async () => {
    const { program } = await Tester.compile(`model M {}`);
    const targets = await loadTargets(program, ["./featured.mjs"], dir, "kotlin");
    expect(program.diagnostics).toEqual([]);
    expect(targets?.[0]?.options).toEqual({ style: "a", features: { module: true, extra: false } });
    expect(targets?.[0]?.features?.values).toEqual({ module: true, extra: false });
    expect([...(targets?.[0]?.features?.explicit ?? [])]).toEqual([]);
  });

  it("rejects unknown target features, naming the key", async () => {
    const { program } = await Tester.compile(`model M {}`);
    const targets = await loadTargets(program, [{ "./featured.mjs": { features: { nope: true } } }], dir, "kotlin");
    expect(targets).toBeUndefined();
    expectDiagnostics(program.diagnostics, {
      code: "@abhigyakrishna/tspgen-core/invalid-target-options",
      message: "Invalid options for target 'f': /features must NOT have additional property 'nope'",
    });
  });

  it("reports moved target options before validating them", async () => {
    const { program } = await Tester.compile(`model M {}`);
    const targets = await loadTargets(program, [{ "./featured.mjs": { module: false } }], dir, "kotlin");
    expect(targets).toBeUndefined();
    expectDiagnostics(program.diagnostics, {
      code: "@abhigyakrishna/tspgen-core/option-moved",
      message: "`module` moved to `features.module` in 0.2.0.",
    });
  });

  it("reports moved options for every target before bailing out, not just the first", async () => {
    const { program } = await Tester.compile(`model M {}`);
    const targets = await loadTargets(
      program,
      [{ "./featured.mjs": { module: false } }, { "./featured.mjs": { module: false, style: "b" } }],
      dir,
      "kotlin",
    );
    expect(targets).toBeUndefined();
    expectDiagnostics(program.diagnostics, [
      { code: "@abhigyakrishna/tspgen-core/option-moved", message: "`module` moved to `features.module` in 0.2.0." },
      { code: "@abhigyakrishna/tspgen-core/option-moved", message: "`module` moved to `features.module` in 0.2.0." },
    ]);
  });

  it("loads the same target twice, and a target whose optionsSchema has $id, without throwing", async () => {
    const { program } = await Tester.compile(`model M {}`);
    const targets = await loadTargets(
      program,
      ["./featured.mjs", "./featured.mjs", "./id-schema.mjs", "./id-schema.mjs"],
      dir,
      "kotlin",
    );
    expect(program.diagnostics).toEqual([]);
    expect(targets).toHaveLength(4);
  });
});

describe("resolveOutputDir", () => {
  it("interpolates and resolves against the project root", () => {
    expect(resolveOutputDir("gen", "/p", "/p/tsp-output/x")).toBe("/p/gen");
    expect(resolveOutputDir("{project-root}/../core/build", "/p/spec", "/o")).toBe("/p/core/build");
    expect(resolveOutputDir("{emitter-output-dir}/server", "/p", "/p/out")).toBe("/p/out/server");
    expect(resolveOutputDir("/abs/dir", "/p", "/o")).toBe("/abs/dir");
    expect(resolveOutputDir("{emitter-output-dir}/", "/p", "/p/out")).toBe("/p/out");
    expect(resolveOutputDir("/", "/p", "/o")).toBe("/");
  });
});
