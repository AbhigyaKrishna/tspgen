import { resolvePath } from "@typespec/compiler";
import { createTester, expectDiagnostics, resolveVirtualPath } from "@typespec/compiler/testing";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  coreFeatures,
  defineFeatures,
  definePlugin,
  mergeMeta,
  reportUnsupportedFeature,
  runPipeline,
  type ApiIR,
  type LanguageModule,
  type ModelIR,
  type Target,
} from "../../src/index.js";
import { emitterFeatures } from "../../src/features.js";
import { Tester } from "../tester.js";

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "tspgen-features-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

interface FakeIR {
  models: ModelIR[];
}

const language: LanguageModule<FakeIR> = {
  name: "fake",
  emitter: "fake-emitter",
  templates: dirWith({ "fake/flags.eta": "<%~ JSON.stringify(it.features) %>" }),
  features: defineFeatures({
    ...coreFeatures,
    lang: { default: true, description: "l" },
    shared: { default: true, description: "s" },
    scoped: { default: true, description: "o", override: "operation" },
  }),
  transform: (ir: ApiIR) => ({ models: ir.types.filter((t): t is ModelIR => t.kind === "model") }),
};

const CORE = { header: true, docs: true, "api-version": true, generics: true };
const KNOWN = "api-version, docs, generics, header, lang, scoped, shared";
const spec = `@service namespace S; model Pet { id: int64 }`;

const MetaTester = createTester(resolvePath(import.meta.dirname, "../.."), {
  libraries: ["@typespec/http", "@abhigyakrishna/tspgen-core"],
})
  .importLibraries()
  .using("Http", "TspGen");

function flagsTarget(seen: Record<string, unknown>): Target<FakeIR> {
  return {
    name: "server",
    kind: "server",
    language: "fake",
    files: (_ir, ctx) => {
      seen.target = ctx.features.values;
      seen.explicit = [...ctx.features.explicit].sort();
      return [{ path: "server.txt", template: "fake/flags", data: {} }];
    },
  };
}

describe("features in the pipeline", () => {
  it("resolves language, plugin and target features for plugins, targets and templates", async () => {
    const { program } = await Tester.compile(spec);
    const out = resolveVirtualPath("out");
    const seen: Record<string, unknown> = {};
    const plugin = definePlugin<FakeIR>({
      name: "p",
      features: { extra: { default: false, description: "e" } },
      setup(ctx) {
        seen.plugin = ctx.features.values;
      },
      files(files) {
        files.push({ path: "plugin.txt", template: "fake/flags", data: {} });
      },
    });
    const serverFeatures = defineFeatures({
      shared: { default: true, description: "s" },
      own: { default: true, description: "o" },
    }).resolve({ shared: false });
    await runPipeline({
      program,
      outputDir: out,
      language,
      targets: [{ target: flagsTarget(seen), options: {}, features: serverFeatures }],
      plugins: [plugin],
      emitterOptions: { features: { lang: false, extra: true } },
    });
    expect(program.diagnostics).toEqual([]);
    expect(seen.plugin).toEqual({ ...CORE, lang: false, shared: true, scoped: true, extra: true });
    expect(seen.target).toEqual({ ...CORE, lang: false, shared: false, scoped: true, extra: true, own: true });
    expect(seen.explicit).toEqual(["extra", "lang", "shared"]);
    const read = async (path: string) => JSON.parse((await program.host.readFile(resolvePath(out, path))).text);
    expect(await read("server.txt")).toEqual(seen.target);
    expect(await read("plugin.txt")).toEqual(seen.plugin);
  });

  it("rejects unknown language features and writes nothing", async () => {
    const { program } = await Tester.compile(spec);
    const out = resolveVirtualPath("out");
    await runPipeline({
      program,
      outputDir: out,
      language,
      targets: [{ target: flagsTarget({}), options: {} }],
      emitterOptions: { features: { nope: true } },
    });
    expectDiagnostics(program.diagnostics, {
      code: "@abhigyakrishna/tspgen-core/unknown-feature",
      severity: "error",
      message: `Unknown feature 'nope' for fake-emitter; known: ${KNOWN}.`,
    });
    await expect(program.host.readFile(resolvePath(out, "server.txt"))).rejects.toThrow();
  });

  it("rejects a plugin feature declared twice", async () => {
    const { program } = await Tester.compile(spec);
    const a = definePlugin<FakeIR>({ name: "a", features: { lang: { default: true, description: "x" } } });
    const b1 = definePlugin<FakeIR>({ name: "b1", features: { twice: { default: true, description: "x" } } });
    const b2 = definePlugin<FakeIR>({ name: "b2", features: { twice: { default: false, description: "y" } } });
    await runPipeline({
      program,
      outputDir: resolveVirtualPath("out"),
      language,
      targets: [{ target: flagsTarget({}), options: {} }],
      plugins: [a, b1, b2],
    });
    expectDiagnostics(program.diagnostics, [
      { code: "@abhigyakrishna/tspgen-core/duplicate-feature", message: "Feature 'lang' is declared by both fake-emitter and plugin 'a'." },
      { code: "@abhigyakrishna/tspgen-core/duplicate-feature", message: "Feature 'twice' is declared by both plugin 'b1' and plugin 'b2'." },
    ]);
  });

  it("reports invalid @meta feature overrides once per declaration", async () => {
    const { program } = await MetaTester.compile(`
      @service namespace S;
      @meta("fake", #{ features: #{ docs: "no", header: false, nope: true } }) model A { id: int32 }
      @meta("fake", #{ features: #{ scoped: false } }) model B { id: int32 }
      @meta("*", #{ features: #{ elsewhere: true } }) model C { id: int32 }
      @meta("fake", #{ features: #{ docs: false } }) model D { id: int32 }
      @meta("fake", #{ features: #{ scoped: false } }) @route("/p") op ping(): void;
    `);
    await runPipeline({ program, outputDir: resolveVirtualPath("out"), language, targets: [] });
    expectDiagnostics(program.diagnostics, [
      { code: "@abhigyakrishna/tspgen-core/invalid-meta", message: "Metadata key 'features.docs' on 'S.A' must be a boolean; it is ignored." },
      {
        code: "@abhigyakrishna/tspgen-core/invalid-meta",
        message: "Metadata key 'features.header' on 'S.A' must be set in tspconfig (this feature has no @meta override); it is ignored.",
      },
      {
        code: "@abhigyakrishna/tspgen-core/invalid-meta",
        message: `Metadata key 'features.nope' on 'S.A' must be a known feature (${KNOWN}); it is ignored.`,
      },
      {
        code: "@abhigyakrishna/tspgen-core/invalid-meta",
        message: "Metadata key 'features.scoped' on 'S.B' must be set on a namespace, interface or operation; it is ignored.",
      },
    ]);
  });

  it("uses the model-only override message for a feature overridden on the wrong kind", async () => {
    const { program } = await MetaTester.compile(`
      @service namespace S;
      @meta("fake", #{ features: #{ generics: false } }) @route("/g") op g(): void;
    `);
    await runPipeline({ program, outputDir: resolveVirtualPath("out"), language, targets: [] });
    expectDiagnostics(program.diagnostics, {
      code: "@abhigyakrishna/tspgen-core/invalid-meta",
      message: "Metadata key 'features.generics' on 'S.g' must be set on a namespace or model; it is ignored.",
    });
  });

  it("does not report a namespace's own @meta as an invalid override of its operations' group", async () => {
    // Operations declared directly in a namespace (no interface) get a group whose id/decorators are that
    // namespace's own; the namespace was already validated as "namespace" while walking the program, and a
    // "model"-override feature (generics) allows a namespace but not an interface.
    const { program } = await MetaTester.compile(`
      @service @meta("fake", #{ features: #{ generics: false } }) namespace S {
        @route("/p") op ping(): void;
        @meta("fake", #{ features: #{ generics: false } })
        namespace Inner {
          @route("/i") op inner(): void;
        }
      }
    `);
    await runPipeline({ program, outputDir: resolveVirtualPath("out"), language, targets: [] });
    expect(program.diagnostics).toEqual([]);
  });

  it("still reports an interface's own @meta override of the wrong kind", async () => {
    const { program } = await MetaTester.compile(`
      @service namespace S;
      @meta("fake", #{ features: #{ generics: false } }) @route("/i") interface I { @get list(): void; }
    `);
    await runPipeline({ program, outputDir: resolveVirtualPath("out"), language, targets: [] });
    expectDiagnostics(program.diagnostics, {
      code: "@abhigyakrishna/tspgen-core/invalid-meta",
      message: "Metadata key 'features.generics' on 'S.I' must be set on a namespace or model; it is ignored.",
    });
  });

  it("reports an invalid @meta feature exactly once for a service namespace that directly declares an operation", async () => {
    // `ping` is declared directly in namespace S (no interface), so its operation group's id and decorators come
    // from S itself; S's own bad `@meta` would otherwise be checked both as "namespace" and as this group's
    // "interface" (see the comment above the service loop in ir/feature-meta.ts).
    const { program } = await MetaTester.compile(`
      @service
      @meta("fake", #{ features: #{ nope: true } })
      namespace S {
        @route("/p") op ping(): void;
      }
    `);
    await runPipeline({ program, outputDir: resolveVirtualPath("out"), language, targets: [] });
    expectDiagnostics(program.diagnostics, {
      code: "@abhigyakrishna/tspgen-core/invalid-meta",
      message: `Metadata key 'features.nope' on 'S' must be a known feature (${KNOWN}); it is ignored.`,
    });
  });

  it("reports duplicate and unknown features together in the same emitterFeatures run", async () => {
    const { program } = await Tester.compile(spec);
    const base = defineFeatures({ shared: { default: true, description: "s" } });
    const result = emitterFeatures(
      program,
      "fake-emitter",
      base,
      [{ name: "a", features: { shared: { default: true, description: "x" } } }],
      { nope: true },
    );
    expect(result).toBeUndefined();
    expectDiagnostics(program.diagnostics, [
      { code: "@abhigyakrishna/tspgen-core/duplicate-feature", message: "Feature 'shared' is declared by both fake-emitter and plugin 'a'." },
      { code: "@abhigyakrishna/tspgen-core/unknown-feature", message: "Unknown feature 'nope' for fake-emitter; known: shared." },
    ]);
  });

  it("merges features objects key by key across meta scopes", () => {
    expect(mergeMeta({ features: { docs: false }, list: ["a"] }, { features: { generics: false }, list: ["b"] })).toEqual({
      features: { docs: false, generics: false },
      list: ["a", "b"],
    });
  });

  it("reports unsupported features only when set to true explicitly", async () => {
    const { program } = await Tester.compile(spec);
    const set = defineFeatures({ x: { default: true, description: "x" } });
    reportUnsupportedFeature(program, set.resolve({}), "x", 'layout "single-file"');
    reportUnsupportedFeature(program, set.resolve({ x: false }), "x", 'layout "single-file"');
    expect(program.diagnostics).toEqual([]);
    reportUnsupportedFeature(program, set.resolve({ x: true }), "x", 'layout "single-file"');
    expectDiagnostics(program.diagnostics, {
      code: "@abhigyakrishna/tspgen-core/unsupported-feature",
      severity: "warning",
      message: '`features.x` has no effect with layout "single-file".',
    });
  });
});
