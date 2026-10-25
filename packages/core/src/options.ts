import { movedOptionSchemas, type MovedOptions } from "./moved-options.js";
import type { SelectionOptions } from "./ir/selection.js";

export interface CoreEmitterOptions extends SelectionOptions {
  "template-dir"?: string;
  plugins?: string[];
  "models-output-dir"?: string;
  version?: string;
  /** Banner text without comment syntax (`features.header`). */
  "header-text"?: string;
  /** On/off gates: core, language and plugin features. */
  features?: Record<string, unknown>;
  /** Moved to `features.generics` in 0.2.0. */
  generics?: unknown;
}

/** Core option keys moved in 0.2.0 (checked by `emitLanguage` for every language emitter). */
export const coreMovedOptions: MovedOptions = { generics: "features.generics" };

/** JSON-schema property fragments every language emitter should include in its options schema. */
export const coreEmitterOptionsSchemaProperties = {
  "model-collection": {
    type: "string",
    enum: ["all", "reachable"],
    default: "all",
    description: "Generate all declarations, or only the transitive types of selected operations and include-types.",
  },
  ...Object.fromEntries(
    ["include-services", "include-operations", "include-types"].map((key) => [key, {
      type: "array",
      items: { type: "string" },
      description: "Exact fully qualified TypeSpec ids to include. Unknown ids are errors.",
    }]),
  ),
  "template-dir": {
    type: "string",
    nullable: true,
    description: "Directory with template overrides; takes precedence over plugin, target and language templates.",
  },
  plugins: {
    type: "array",
    items: { type: "string" },
    nullable: true,
    description: "Plugin modules (relative paths or package names) applied in order.",
  },
  "models-output-dir": {
    type: "string",
    nullable: true,
    description:
      "Output directory of the built-in models (default: emitter-output-dir). Relative to the project root; " +
      "{project-root} and {emitter-output-dir} are interpolated. Targets take `output-dir` in their options.",
  },
  version: {
    type: "string",
    nullable: true,
    description:
      "Version of @versioned services to generate: a version enum member's name or value (default: the latest).",
  },
  "header-text": {
    type: "string",
    nullable: true,
    description:
      "Banner at the top of every generated file, without comment syntax (each line becomes a line comment; " +
      "multi-line allowed). Needs features.header.",
  },
  ...movedOptionSchemas(coreMovedOptions),
} as const;
