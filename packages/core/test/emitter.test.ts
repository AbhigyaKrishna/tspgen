import { resolvePath, type EmitContext } from "@typespec/compiler";
import { expectDiagnostics, resolveVirtualPath } from "@typespec/compiler/testing";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  emitLanguage,
  MANIFEST_FILE,
  movedOptionSchemas,
  type LanguageEmitterOptions,
  type LanguageModule,
  type Target,
} from "../src/index.js";
import { Tester } from "./tester.js";

describe("emitLanguage", () => {
  it("reports the language's moved options before loading plugins, and writes nothing", async () => {
    const { program } = await Tester.compile(`model M {}`);
    const movedOptions = { zod: "features.zod" };
    // A real emitter's own JSON schema (validated by the compiler before `$onEmit` runs) spreads
    // `movedOptionSchemas(movedOptions)` into its `properties` so a moved key like `zod` still passes that
    // validation and reaches `emitLanguage`, which then reports it as `option-moved` itself.
    expect(movedOptionSchemas(movedOptions)).toEqual({ zod: { description: "Moved to features.zod in 0.2.0." } });
    const language: LanguageModule<unknown> = {
      name: "fake",
      templates: resolveVirtualPath("templates"),
      movedOptions,
      transform: () => ({}),
    };
    const out = resolveVirtualPath("out");
    // A minimal stand-in for the `EmitContext` the compiler passes to `$onEmit`: `emitLanguage` reads only
    // `program`, `options` and `emitterOutputDir` from it.
    const context = {
      program,
      emitterOutputDir: out,
      options: { zod: true } as LanguageEmitterOptions,
    } as unknown as EmitContext<LanguageEmitterOptions>;
    await emitLanguage(context, language, [] as Target<unknown>[]);
    expectDiagnostics(program.diagnostics, {
      code: "@abhigyakrishna/tspgen-core/option-moved",
      message: "`zod` moved to `features.zod` in 0.2.0.",
    });
    await expect(program.host.readFile(resolvePath(out, MANIFEST_FILE))).rejects.toThrow();
  });

  it("reports a language-level and a target-level moved option together in one run", async () => {
    const { program } = await Tester.compile(`model M {}`);
    const dir = mkdtempSync(join(tmpdir(), "tspgen-emitlanguage-"));
    writeFileSync(
      join(dir, "target.mjs"),
      `export default {
        name: "t", kind: "server", language: "fake",
        movedOptions: { "call-access": "features.call-access" },
        optionsSchema: { type: "object", additionalProperties: false, properties: { "call-access": { description: "moved" } } },
        files: () => [],
      };`,
    );
    const language: LanguageModule<unknown> = {
      name: "fake",
      templates: resolveVirtualPath("templates"),
      movedOptions: { zod: "features.zod" },
      transform: () => ({}),
    };
    const context = {
      program,
      emitterOutputDir: resolveVirtualPath("out"),
      options: {
        zod: true,
        targets: [{ "./target.mjs": { "call-access": "public" } }],
      } as LanguageEmitterOptions,
    } as unknown as EmitContext<LanguageEmitterOptions>;
    // `loadModuleDefault` resolves specifiers against `program.projectRoot`, not this test file.
    Object.defineProperty(program, "projectRoot", { value: dir, configurable: true });
    await emitLanguage(context, language, [] as Target<unknown>[]);
    expectDiagnostics(program.diagnostics, [
      { code: "@abhigyakrishna/tspgen-core/option-moved", message: "`zod` moved to `features.zod` in 0.2.0." },
      {
        code: "@abhigyakrishna/tspgen-core/option-moved",
        message: "`call-access` moved to `features.call-access` in 0.2.0.",
      },
    ]);
  });
});
