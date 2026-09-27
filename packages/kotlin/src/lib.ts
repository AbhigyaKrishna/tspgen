import { coreEmitterOptionsSchemaProperties, type CoreEmitterOptions, type TargetSpec } from "@abhigyakrishna/tspgen-core";
import { createTypeSpecLibrary, paramMessage, type JSONSchemaType } from "@typespec/compiler";

export type EnumMemberNaming = "UPPER_SNAKE" | "PascalCase";

export interface KotlinEmitterOptions extends CoreEmitterOptions {
  package?: string;
  targets?: TargetSpec[];
  naming?: { "enum-members"?: EnumMemberNaming };
  packages?: { namespace: string; package: string }[];
  errors?: "typed" | "thrown";
  validation?: boolean;
  "date-time"?: "java.time" | "kotlin.time";
  "union-variants"?: "nested" | "top-level";
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
    packages: {
      type: "array",
      nullable: true,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["namespace", "package"],
        properties: { namespace: { type: "string" }, package: { type: "string" } },
      },
      description:
        'TypeSpec namespace → Kotlin package, e.g. [{ namespace: "Shop.Graph", package: "com.acme.graph" }]; longest prefix wins.',
    },
    errors: {
      type: "string",
      enum: ["typed", "thrown"],
      nullable: true,
      description: "typed (default): …Exception per error body; thrown: error responses are documentation only.",
    },
    validation: {
      type: "boolean",
      nullable: true,
      description: "Render constraint decorators as init { require(...) } checks (default false).",
    },
    "date-time": {
      type: "string",
      enum: ["java.time", "kotlin.time"],
      nullable: true,
      description:
        "java.time (default): Instant, OffsetDateTime, LocalDate, LocalTime, Duration from java.time with generated " +
        "ISO-8601 serializers; kotlin.time: kotlin.time.Instant/Duration and kotlinx.datetime dates.",
    },
    "union-variants": {
      type: "string",
      enum: ["nested", "top-level"],
      nullable: true,
      description:
        "nested (default): variant models only a sealed union references are declared inside it, named after the " +
        "variant key (NodeSource.Catalog); top-level: every variant is its own file.",
    },
  },
  required: [],
} as const;

export const $lib = createTypeSpecLibrary({
  name: "@abhigyakrishna/tspgen-kotlin",
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
    "http-file-conflict": {
      severity: "error",
      messages: {
        default: paramMessage`Model '${"id"}' is generated as '${"fqn"}', the class the API's file types map to. Rename it with @Kotlin.name.`,
      },
    },
  },
  emitter: { options: optionsSchema as unknown as JSONSchemaType<KotlinEmitterOptions> },
});

export const { reportDiagnostic } = $lib;
