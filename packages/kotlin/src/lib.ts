import {
  coreEmitterOptionsSchemaProperties,
  coreFeatures,
  defaultHeaderText,
  defineFeatures,
  movedOptionSchemas,
  type CoreEmitterOptions,
  type MovedOptions,
  type TargetSpec,
} from "@abhigyakrishna/tspgen-core";
import { createTypeSpecLibrary, paramMessage, type JSONSchemaType } from "@typespec/compiler";

export type EnumMemberNaming = "UPPER_SNAKE" | "PascalCase";

export const KOTLIN_EMITTER = "@abhigyakrishna/tspgen-kotlin";

export const kotlinFeatures = defineFeatures({
  ...coreFeatures,
  validation: {
    default: true,
    description:
      "Constraint decorators (@minLength, @maxLength, @pattern, @minItems, @maxItems, @minValue, @maxValue) as init { require(...) } checks.",
  },
  "enum-unknown": {
    default: false,
    override: "declaration",
    description:
      "String enums get an UNKNOWN member that unknown wire values decode to (encoding it throws); for clients — servers should reject unknown input.",
  },
});

/** Kotlin emitter option keys moved in 0.2.0. */
export const kotlinMovedOptions: MovedOptions = { validation: "features.validation" };

export interface KotlinEmitterOptions extends CoreEmitterOptions {
  package?: string;
  targets?: TargetSpec[];
  naming?: { "enum-members"?: EnumMemberNaming };
  packages?: { namespace: string; package: string }[];
  errors?: "typed" | "thrown";
  /** Moved to `features.validation` in 0.2.0. */
  validation?: unknown;
  visibility?: "public" | "internal";
  "file-annotations"?: string[];
  "date-time"?: "java.time" | "kotlin.time";
  decimal?: "big-decimal" | "string";
  "union-variants"?: "nested" | "top-level";
  "scalar-style"?: "inline" | "typealias" | "value-class";
}

const optionsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...coreEmitterOptionsSchemaProperties,
    "header-text": {
      ...coreEmitterOptionsSchemaProperties["header-text"],
      default: defaultHeaderText(KOTLIN_EMITTER),
    },
    features: kotlinFeatures.openSchema,
    package: {
      type: "string",
      nullable: true,
      default: "generated",
      description: 'Base Kotlin package (default "generated").',
    },
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
      description: "Naming conventions for generated Kotlin identifiers.",
      properties: {
        "enum-members": {
          type: "string",
          enum: ["UPPER_SNAKE", "PascalCase"],
          nullable: true,
          description: "Casing of generated enum constant names (default UPPER_SNAKE).",
        },
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
      default: "typed",
      description: "typed (default): …Exception per error body; thrown: error responses are documentation only.",
    },
    "date-time": {
      type: "string",
      enum: ["java.time", "kotlin.time"],
      nullable: true,
      default: "java.time",
      description:
        "java.time (default): Instant, OffsetDateTime, LocalDate, LocalTime, Duration from java.time with generated " +
        "ISO-8601 serializers; kotlin.time: kotlin.time.Instant/Duration and kotlinx.datetime dates.",
    },
    decimal: {
      type: "string",
      enum: ["big-decimal", "string"],
      nullable: true,
      default: "big-decimal",
      description:
        "decimal/decimal128 as java.math.BigDecimal (default; generated serializer writes a JSON string, reads a string or number) or String.",
    },
    "scalar-style": {
      type: "string",
      enum: ["inline", "typealias", "value-class"],
      nullable: true,
      default: "inline",
      description:
        "User scalars (scalar PetId extends string): inline (the base type), typealias PetId = String, or @JvmInline value class PetId(val value: String). Per scalar: @meta scalarStyle.",
    },
    "union-variants": {
      type: "string",
      enum: ["nested", "top-level"],
      nullable: true,
      default: "nested",
      description:
        "nested (default): variant models only a sealed union references are declared inside it, named after the " +
        "variant key (NodeSource.Catalog); top-level: every variant is its own file.",
    },
    visibility: {
      type: "string",
      enum: ["public", "internal"],
      nullable: true,
      default: "public",
      description:
        "Modifier on every generated top-level declaration, targets' included; public renders none. internal " +
        "requires all generated code (models and every target's output) to compile in ONE Gradle module: it " +
        "breaks layouts where models-output-dir / a target's output-dir point at different modules.",
    },
    "file-annotations": {
      type: "array",
      items: { type: "string" },
      nullable: true,
      default: [],
      description:
        'Extra @file: annotations, e.g. Suppress("unused") or @file:Suppress("unused") (a leading "@file:" is ' +
        "stripped). Applies to every generated Kotlin file, targets included, after UseSerializers; must not " +
        "repeat it.",
    },
    ...movedOptionSchemas(kotlinMovedOptions),
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
    "sse-message-conflict": {
      severity: "error",
      messages: {
        default: paramMessage`Model '${"id"}' is generated as '${"fqn"}', the class untyped server-sent events map to. Rename it with @Kotlin.name.`,
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
