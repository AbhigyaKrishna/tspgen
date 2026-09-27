import { resolvePath } from "@typespec/compiler";
import { expectDiagnostics, resolveVirtualPath } from "@typespec/compiler/testing";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  definePlugin,
  runPipeline,
  type ApiIR,
  type LanguageModule,
  type ModelIR,
  type Target,
} from "../../src/index.js";
import { Tester } from "../tester.js";

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "tspgen-pipe-"));
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
  templates: dirWith({ "fake/model.eta": "model <%= it.model.name %><%= it.h.suffix %>" }),
  helpers: { suffix: "" },
  transform: (ir: ApiIR) => ({ models: ir.types.filter((t): t is ModelIR => t.kind === "model") }),
};

const target: Target<FakeIR> = {
  name: "fake-models",
  kind: "models",
  language: "fake",
  files: (ir) => ir.models.map((m) => ({ path: `models/${m.name}.txt`, template: "fake/model", data: { model: m } })),
};

const spec = `@service namespace S; model Pet { id: int64 } model Owner { id: int64 }`;

describe("runPipeline", () => {
  it("transforms, plans, renders and writes files", async () => {
    const { program } = await Tester.compile(spec);
    const out = resolveVirtualPath("out");
    await runPipeline({ program, outputDir: out, language, targets: [{ target, options: {} }] });
    expect((await program.host.readFile(resolvePath(out, "models/Pet.txt"))).text).toBe("model Pet");
    expect((await program.host.readFile(resolvePath(out, "models/Owner.txt"))).text).toBe("model Owner");
  });

  it("applies plugin IR transforms, file hooks, templates and helpers", async () => {
    const { program } = await Tester.compile(spec);
    const out = resolveVirtualPath("out");
    const plugin = definePlugin<FakeIR>({
      name: "rename",
      transformIR(ir) {
        ir.models = ir.models.filter((m) => m.name !== "Owner");
      },
      files(files) {
        files.push({ path: "extra.txt", template: "extra", data: {} });
      },
      templates: dirWith({ "extra.eta": "extra!" }),
      helpers: { suffix: "!" },
    });
    await runPipeline({ program, outputDir: out, language, targets: [{ target, options: {} }], plugins: [plugin] });
    expect((await program.host.readFile(resolvePath(out, "models/Pet.txt"))).text).toBe("model Pet!");
    expect((await program.host.readFile(resolvePath(out, "extra.txt"))).text).toBe("extra!");
    await expect(program.host.readFile(resolvePath(out, "models/Owner.txt"))).rejects.toThrow();
  });

  it("user template-dir overrides everything", async () => {
    const { program } = await Tester.compile(spec);
    const out = resolveVirtualPath("out");
    const templateDir = dirWith({ "fake/model.eta": "custom <%= it.model.name %>" });
    await runPipeline({ program, outputDir: out, language, targets: [{ target, options: {} }], templateDir });
    expect((await program.host.readFile(resolvePath(out, "models/Pet.txt"))).text).toBe("custom Pet");
  });

  it("tells targets which file renders a template (resolveTemplate)", async () => {
    const { program } = await Tester.compile(spec);
    const templateDir = dirWith({ "fake/model.eta": "custom" });
    const seen: Record<string, string | undefined> = {};
    const probe: Target<FakeIR> = {
      ...target,
      files: (_ir, ctx) => {
        seen.model = ctx.resolveTemplate?.("fake/model");
        seen.missing = ctx.resolveTemplate?.("missing");
        return [];
      },
    };
    await runPipeline({ program, outputDir: resolveVirtualPath("out"), language, targets: [{ target: probe, options: {} }], templateDir });
    expect(seen).toEqual({ model: join(templateDir, "fake/model.eta"), missing: undefined });
  });

  it("reports template errors and writes nothing", async () => {
    const { program } = await Tester.compile(spec);
    const out = resolveVirtualPath("out");
    const broken: Target<FakeIR> = { ...target, files: () => [{ path: "x.txt", template: "missing", data: {} }] };
    await runPipeline({ program, outputDir: out, language, targets: [{ target: broken, options: {} }] });
    expectDiagnostics(program.diagnostics, { code: "@abhigyakrishna/tspgen-core/template-error" });
    await expect(program.host.readFile(resolvePath(out, "x.txt"))).rejects.toThrow();
  });

  it("reports duplicate output paths", async () => {
    const { program } = await Tester.compile(spec);
    const dup: Target<FakeIR> = { ...target, files: () => [
      { path: "a.txt", template: "fake/model", data: { model: { name: "A" } } },
      { path: "a.txt", template: "fake/model", data: { model: { name: "B" } } },
    ] };
    await runPipeline({ program, outputDir: resolveVirtualPath("out"), language, targets: [{ target: dup, options: {} }] });
    expectDiagnostics(program.diagnostics, { code: "@abhigyakrishna/tspgen-core/duplicate-file" });
  });

  it("writes each target to its own output dir, with a manifest per dir", async () => {
    const { program } = await Tester.compile(spec);
    const out = resolveVirtualPath("out");
    const serverDir = resolveVirtualPath("server-out");
    let seen: { outputDir: string; modelsOutputDir: string } | undefined;
    const server: Target<FakeIR> = {
      name: "fake-server",
      kind: "server",
      language: "fake",
      files: (_ir, ctx) => {
        seen = { outputDir: ctx.outputDir, modelsOutputDir: ctx.modelsOutputDir };
        return [{ path: "server/Routes.txt", template: "fake/model", data: { model: { name: "Routes" } } }];
      },
    };
    await runPipeline({
      program,
      outputDir: out,
      language,
      targets: [{ target, options: {} }, { target: server, options: {}, outputDir: serverDir }],
    });
    expect(seen).toEqual({ outputDir: serverDir, modelsOutputDir: out });
    expect((await program.host.readFile(resolvePath(serverDir, "server/Routes.txt"))).text).toBe("model Routes");
    await expect(program.host.readFile(resolvePath(out, "server/Routes.txt"))).rejects.toThrow();
    const manifest = async (dir: string) =>
      JSON.parse((await program.host.readFile(resolvePath(dir, ".generated-manifest.json"))).text).files;
    expect(await manifest(out)).toEqual(["models/Owner.txt", "models/Pet.txt"]);
    expect(await manifest(serverDir)).toEqual(["server/Routes.txt"]);
  });

  it("cleans up a directory a target no longer writes to", async () => {
    const { program } = await Tester.compile(spec);
    const out = resolveVirtualPath("out");
    const server: Target<FakeIR> = {
      name: "fake-server",
      kind: "server",
      language: "fake",
      files: () => [{ path: "server/R.txt", template: "fake/model", data: { model: { name: "R" } } }],
    };
    const run = (dir: string) =>
      runPipeline({ program, outputDir: out, language, targets: [{ target, options: {} }, { target: server, options: {}, outputDir: dir }] });
    const x = resolveVirtualPath("x");
    const y = resolveVirtualPath("y");
    await run(x);
    expect((await program.host.readFile(resolvePath(x, "server/R.txt"))).text).toBe("model R");
    await run(y);
    await expect(program.host.readFile(resolvePath(x, "server/R.txt"))).rejects.toThrow();
    expect((await program.host.readFile(resolvePath(y, "server/R.txt"))).text).toBe("model R");
  });

  it("treats a directory with a trailing slash as the same directory", async () => {
    const { program } = await Tester.compile(spec);
    const out = resolveVirtualPath("out");
    const server: Target<FakeIR> = {
      name: "fake-server",
      kind: "server",
      language: "fake",
      files: () => [{ path: "server/R.txt", template: "fake/model", data: { model: { name: "R" } } }],
    };
    await runPipeline({
      program,
      outputDir: out,
      language,
      targets: [{ target, options: {}, outputDir: `${out}/` }, { target: server, options: {} }],
    });
    expect((await program.host.readFile(resolvePath(out, "server/R.txt"))).text).toBe("model R");
    const manifest = JSON.parse((await program.host.readFile(resolvePath(out, ".generated-manifest.json"))).text);
    expect(manifest.files).toEqual(["models/Owner.txt", "models/Pet.txt", "server/R.txt"]);
    expect(Object.keys(manifest.owners)).toEqual(["fake"]);
  });

  it("allows the same relative path in different output dirs", async () => {
    const { program } = await Tester.compile(spec);
    const other = { ...target, name: "other" };
    await runPipeline({
      program,
      outputDir: resolveVirtualPath("out"),
      language,
      targets: [{ target, options: {} }, { target: other, options: {}, outputDir: resolveVirtualPath("elsewhere") }],
    });
    expect(program.diagnostics).toEqual([]);
  });

  it("reports plugin failures with the plugin name", async () => {
    const { program } = await Tester.compile(spec);
    const bad = definePlugin<FakeIR>({ name: "bad", transformIR() { throw new Error("boom"); } });
    await runPipeline({ program, outputDir: resolveVirtualPath("out"), language, targets: [{ target, options: {} }], plugins: [bad] });
    expectDiagnostics(program.diagnostics, {
      code: "@abhigyakrishna/tspgen-core/plugin-failed",
      message: "Plugin 'bad' failed during transformIR: boom",
    });
  });
});
