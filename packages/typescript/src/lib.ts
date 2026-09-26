import { coreEmitterOptionsSchemaProperties, type LanguageEmitterOptions } from "@specgen/emitter-core";
import { createTypeSpecLibrary, paramMessage, type JSONSchemaType } from "@typespec/compiler";

export interface TypeScriptEmitterOptions extends LanguageEmitterOptions {
  zod?: boolean;
  "import-extension"?: "none" | ".js";
}

const optionsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...coreEmitterOptionsSchemaProperties,
    zod: { type: "boolean", nullable: true, description: "Emit zod schemas next to the types (default false)." },
    "import-extension": {
      type: "string",
      enum: ["none", ".js"],
      nullable: true,
      description: 'Suffix for relative imports: "none" for bundlers/Next.js (default), ".js" for Node ESM.',
    },
    targets: {
      type: "array",
      nullable: true,
      items: {
        anyOf: [
          { type: "string" },
          { type: "object", minProperties: 1, maxProperties: 1, additionalProperties: { type: "object" } },
        ],
      },
    },
  },
  required: [],
} as const;

export const $lib = createTypeSpecLibrary({
  name: "@specgen/emitter-typescript",
  diagnostics: {
    "non-json-body": {
      severity: "warning",
      messages: {
        default: paramMessage`Operation '${"operation"}' has a non-JSON body (${"contentType"}); only a client method is generated for it.`,
      },
    },
    "duplicate-type-name": {
      severity: "error",
      messages: {
        default: paramMessage`TypeScript type '${"name"}' is generated from both '${"first"}' and '${"second"}'. Use @TS.name to disambiguate.`,
      },
    },
  },
  emitter: { options: optionsSchema as unknown as JSONSchemaType<TypeScriptEmitterOptions> },
});

export const { reportDiagnostic } = $lib;
