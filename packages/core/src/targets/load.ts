import { NoTarget, type Program } from "@typespec/compiler";
import { errorMessage, reportDiagnostic } from "../lib.js";
import { loadModuleDefault } from "../loader.js";
import { validateOptions } from "../options-validate.js";
import type { PipelineTarget } from "../pipeline/run.js";
import type { Target } from "./target.js";

/** A target reference from emitter options: `"pkg"` or `{ "pkg": { ...options } }`. */
export type TargetSpec = string | Record<string, Record<string, unknown> | null>;

export async function loadTargets<L>(
  program: Program,
  specs: readonly TargetSpec[],
  baseDir: string,
  language: string,
): Promise<PipelineTarget<L>[] | undefined> {
  const loaded: PipelineTarget<L>[] = [];
  for (const spec of specs) {
    const [specifier, raw] = typeof spec === "string" ? [spec, {}] : (Object.entries(spec)[0] ?? ["", {}]);
    let target: Target<L>;
    try {
      target = await loadModuleDefault<Target<L>>(specifier, baseDir);
      if (!target || typeof target.name !== "string" || typeof target.files !== "function") {
        throw new Error("default export is not a tspgen target (missing 'name' or 'files')");
      }
      if (target.language !== language) {
        throw new Error(`target is for language '${target.language}', not '${language}'`);
      }
    } catch (error) {
      reportDiagnostic(program, {
        code: "module-load-failed",
        format: { kind: "target", specifier, message: errorMessage(error) },
        target: NoTarget,
      });
      return undefined;
    }
    const options = structuredClone(raw ?? {});
    // `output-dir` belongs to the pipeline, not the target: take it out before the target's schema sees it.
    const outputDir = options["output-dir"];
    delete options["output-dir"];
    if (outputDir !== undefined && typeof outputDir !== "string") {
      reportDiagnostic(program, {
        code: "invalid-target-options",
        format: { name: target.name, errors: "/output-dir must be string" },
        target: NoTarget,
      });
      return undefined;
    }
    if (target.optionsSchema) {
      const errors = validateOptions(target.optionsSchema, options);
      if (errors.length > 0) {
        reportDiagnostic(program, {
          code: "invalid-target-options",
          format: { name: target.name, errors: errors.join("; ") },
          target: NoTarget,
        });
        return undefined;
      }
    }
    loaded.push({ target, options, ...(outputDir ? { outputDir } : {}) });
  }
  return loaded;
}
