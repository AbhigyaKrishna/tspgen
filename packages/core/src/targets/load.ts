import { NoTarget, type Program } from "@typespec/compiler";
import { errorMessage, reportDiagnostic } from "../lib.js";
import { loadModuleDefault } from "../loader.js";
import { checkMovedOptions } from "../moved-options.js";
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
  // A moved key is reported for every target before this function returns undefined (rather than bailing out at
  // the first one), so one run surfaces every moved key across all configured targets, not just the first target's.
  let movedFailed = false;
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
    if (target.movedOptions && !checkMovedOptions(program, options, target.movedOptions)) {
      movedFailed = true;
      continue;
    }
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
    // Explicitly set features, before the schema fills in the defaults.
    const configuredFeatures = structuredClone(options.features);
    const schema = targetSchema(target);
    if (schema) {
      const errors = validateOptions(schema, options);
      if (errors.length > 0) {
        reportDiagnostic(program, {
          code: "invalid-target-options",
          format: { name: target.name, errors: errors.join("; ") },
          target: NoTarget,
        });
        return undefined;
      }
    }
    loaded.push({
      target,
      options,
      ...(outputDir ? { outputDir } : {}),
      ...(target.features ? { features: target.features.resolve(configuredFeatures) } : {}),
    });
  }
  return movedFailed ? undefined : loaded;
}

/** `schema` with a `features` property (`features` is the target's `FeatureSet.schema`). */
function withFeatures(schema: object | undefined, features: object): object {
  const base = (schema ?? { type: "object", additionalProperties: false, properties: {} }) as {
    properties?: Record<string, unknown>;
  };
  return { ...base, properties: { ...base.properties, features } };
}

/**
 * A target's option schema merged with its `features` schema, memoized by target object identity: `validateOptions`
 * compiles it with a module-level ajv instance that caches (and, for a schema with `$id`, rejects a re-registration
 * of) a schema by object reference, so `loadTargets` must hand it the same object on every call for the same
 * target, not a fresh one built by `withFeatures` each time (which would throw "schema with key or id already
 * exists" for a target whose `optionsSchema` declares `$id`, and would otherwise leak one cache entry per call).
 */
const schemaCache = new WeakMap<Target<unknown>, object | undefined>();
function targetSchema<L>(target: Target<L>): object | undefined {
  if (!target.features) return target.optionsSchema;
  const key = target as Target<unknown>;
  if (!schemaCache.has(key)) schemaCache.set(key, withFeatures(target.optionsSchema, target.features.schema));
  return schemaCache.get(key);
}
