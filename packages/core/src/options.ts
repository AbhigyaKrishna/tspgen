export interface CoreEmitterOptions {
  "template-dir"?: string;
  plugins?: string[];
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
} as const;
