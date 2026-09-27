import { resolvePath } from "@typespec/compiler";
import { createTester, expectDiagnostics, resolveVirtualPath } from "@typespec/compiler/testing";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runPipeline, type ApiIR, type LanguageModule, type Target } from "../../src/index.js";

// The compiler loads the library's decorators through its own entry point; only tspgen's import fails.
vi.mock("@typespec/versioning", () => {
  throw new Error("cannot load");
});

const templates = mkdtempSync(join(tmpdir(), "tspgen-ver-"));
writeFileSync(join(templates, "t.eta"), "<%= it.names %>");
const language: LanguageModule<ApiIR> = { name: "fake", templates, helpers: {}, transform: (ir: ApiIR) => ir };
const target: Target<ApiIR> = {
  name: "fake",
  kind: "models",
  language: "fake",
  files: (ir) => [{ path: "types.txt", template: "t", data: { names: ir.types.map((t) => t.id).join(",") } }],
};

it("writes nothing when @typespec/versioning cannot be loaded (no unversioned fallback)", async () => {
  const { program } = await createTester(resolvePath(import.meta.dirname, "../.."), {
    libraries: ["@typespec/http", "@typespec/versioning"],
  })
    .importLibraries()
    .using("Http", "Versioning")
    .compile(`@service @versioned(V) namespace S; enum V { v1, v2 } model Pet { id: int64 }`);
  const out = resolveVirtualPath("out");
  await program.host.mkdirp(out);
  await program.host.writeFile(resolvePath(out, "types.txt"), "earlier");
  await runPipeline({ program, outputDir: out, language, targets: [{ target, options: {} }] });
  expectDiagnostics(program.diagnostics, { code: "@abhigyakrishna/tspgen-core/module-load-failed" });
  expect((await program.host.readFile(resolvePath(out, "types.txt"))).text).toBe("earlier");
  await expect(program.host.readFile(resolvePath(out, ".generated-manifest.json"))).rejects.toThrow();
});
