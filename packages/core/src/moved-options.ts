import { NoTarget, type Program } from "@typespec/compiler";
import { reportDiagnostic } from "./lib.js";

/** Option keys removed in 0.2.0 → where they live now, e.g. `{ zod: "features.zod" }`. */
export type MovedOptions = Readonly<Record<string, string>>;

/**
 * Accept-anything schema properties for moved keys of a language emitter: the compiler validates emitter options
 * against the schema before `$onEmit`, so the keys must pass it to reach `checkMovedOptions`.
 */
export function movedOptionSchemas(moved: MovedOptions): Record<string, { description: string }> {
  return Object.fromEntries(Object.entries(moved).map(([key, to]) => [key, { description: `Moved to ${to} in 0.2.0.` }]));
}

/** Reports `option-moved` for every moved key present in `options`; false when there was one. */
export function checkMovedOptions(program: Program, options: Record<string, unknown>, moved: MovedOptions): boolean {
  const hits = Object.keys(options).filter((key) => Object.hasOwn(moved, key));
  for (const key of hits) {
    reportDiagnostic(program, { code: "option-moved", format: { key, to: moved[key]! }, target: NoTarget });
  }
  return hits.length === 0;
}
