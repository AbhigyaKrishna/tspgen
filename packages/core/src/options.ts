export interface CoreEmitterOptions {
  "template-dir"?: string;
  plugins?: string[];
  "models-output-dir"?: string;
  generics?: boolean;
}

/** JSON-schema property fragments every language emitter should include in its options schema. */
export const coreEmitterOptionsSchemaProperties = {
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
  generics: {
    type: "boolean",
    nullable: true,
    description:
      "Emit template models once as generic types (Page<T>) instead of one model per instance (default true).",
  },
} as const;
