import { coreEmitterOptionsSchemaProperties, type CoreEmitterOptions, type TargetSpec } from "@specgen/emitter-core";
import { createTypeSpecLibrary, paramMessage, type JSONSchemaType } from "@typespec/compiler";

export type EnumMemberNaming = "UPPER_SNAKE" | "PascalCase";

export interface KotlinEmitterOptions extends CoreEmitterOptions {
  package?: string;
  targets?: TargetSpec[];
  naming?: { "enum-members"?: EnumMemberNaming };
}

const optionsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...coreEmitterOptionsSchemaProperties,
    package: { type: "string", nullable: true, description: 'Base Kotlin package (default "generated").' },
    targets: {
      type: "array",
      nullable: true,
      description: "Server/client targets: a package name or path, optionally mapped to target options.",
      items: {
        anyOf: [
          { type: "string" },
          { type: "object", minProperties: 1, maxProperties: 1, additionalProperties: { type: "object" } },
        ],
      },
    },
    naming: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      properties: {
        "enum-members": { type: "string", enum: ["UPPER_SNAKE", "PascalCase"], nullable: true },
      },
    },
  },
  required: [],
} as const;

export const $lib = createTypeSpecLibrary({
  name: "@specgen/emitter-kotlin",
  diagnostics: {
    "unsupported-union": {
      severity: "warning",
      messages: {
        default: paramMessage`Union '${"id"}' cannot be represented precisely in Kotlin; it is emitted as JsonElement.`,
      },
    },
    "numeric-enum": {
      severity: "warning",
      messages: {
        default: paramMessage`Enum '${"id"}' has numeric values; it is emitted as a typealias to ${"type"}.`,
      },
    },
    "additional-properties": {
      severity: "warning",
      messages: {
        default: paramMessage`Model '${"id"}' allows additional properties; they are not represented in Kotlin.`,
      },
    },
    "duplicate-type-name": {
      severity: "error",
      messages: {
        default: paramMessage`Kotlin type '${"fqn"}' is generated from both '${"first"}' and '${"second"}'. Use @Kotlin.name or @Kotlin.packageName to disambiguate.`,
      },
    },
  },
  emitter: { options: optionsSchema as unknown as JSONSchemaType<KotlinEmitterOptions> },
});

export const { reportDiagnostic } = $lib;
