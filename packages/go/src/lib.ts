import {
  coreEmitterOptionsSchemaProperties,
  coreFeatures,
  defaultHeaderText,
  defineFeatures,
  type LanguageEmitterOptions,
} from "@abhigyakrishna/tspgen-core";
import { createTypeSpecLibrary, paramMessage, type JSONSchemaType } from "@typespec/compiler";
import { goOptionsSchemaProperties, type GoNaming, type GoOptions } from "./options.js";

export const GO_EMITTER = "@abhigyakrishna/tspgen-go";
export const goFeatures = defineFeatures({
  ...coreFeatures,
  validation: {
    default: true,
    override: "model",
    description: "Generate Validate methods for constraints, literals and enum values, and validate required JSON properties when HTTP targets enable validate.",
  },
  validator: {
    default: false,
    override: "model",
    description: "Generate go-playground/validator/v10 struct tags for supported constraints, literals, enums and nested collections. Independent of generated Validate methods; no runtime dependency is added.",
  },
  defaults: {
    default: true,
    override: "model",
    description: "Apply declared property defaults when decoding missing JSON properties and generate model constructors that initialize them.",
  },
  "omit-empty": {
    default: true,
    description: "Optional model properties carry json omitempty tags. Pointer fields preserve present zero values; value fields omit zero values.",
  },
  "enum-unknown": {
    default: false,
    override: "declaration",
    description: "String enums decode unknown wire values to an UNKNOWN sentinel accepted by validation (encoding it fails). Unions keep payloads matching no variant in an Unknown field, re-encoded unchanged and rejected by validation.",
  },
  "go-mod": {
    default: true,
    description: "Generate the models go.mod. Client/server targets have their own go-mod feature.",
  },
});

export interface GoEmitterOptions extends LanguageEmitterOptions {
  module: string;
  package?: string;
  "go-version"?: string;
  layout?: GoOptions["layout"];
  naming?: GoNaming;
  "type-names"?: Record<string, string>;
  "date-time"?: GoOptions["dateTime"];
  decimal?: GoOptions["decimal"];
  integer?: GoOptions["integer"];
  "scalar-style"?: GoOptions["scalarStyle"];
  "optional-fields"?: GoOptions["optionalFields"];
}

const optionsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...coreEmitterOptionsSchemaProperties,
    "header-text": { ...coreEmitterOptionsSchemaProperties["header-text"], default: defaultHeaderText(GO_EMITTER) },
    features: goFeatures.openSchema,
    ...goOptionsSchemaProperties,
    module: { type: "string", description: "Import path of the generated models Go module." },
    package: { type: "string", default: "models", description: "Package name of generated models." },
    targets: {
      type: "array",
      nullable: true,
      items: { anyOf: [{ type: "string" }, { type: "object", minProperties: 1, maxProperties: 1, additionalProperties: { type: "object" } }] },
    },
  },
  required: ["module"],
} as const;

export const $lib = createTypeSpecLibrary({
  name: GO_EMITTER,
  diagnostics: {
    "unsupported-type": {
      severity: "error",
      messages: { default: paramMessage`Cannot generate Go type '${"id"}': ${"reason"}.` },
    },
    "duplicate-name": {
      severity: "error",
      messages: { default: paramMessage`Go identifier '${"name"}' is generated from both '${"first"}' and '${"second"}'.` },
    },
    "invalid-package": {
      severity: "error",
      messages: { default: paramMessage`'${"name"}' is not a valid Go package name.` },
    },
    "invalid-module": {
      severity: "error",
      messages: { default: paramMessage`'${"name"}' is not a valid Go module path.` },
    },
    "unsupported-operation": {
      severity: "error",
      messages: { default: paramMessage`Cannot generate Go operation '${"id"}': ${"reason"}.` },
    },
  },
  emitter: { options: optionsSchema as unknown as JSONSchemaType<GoEmitterOptions> },
});

export const { reportDiagnostic } = $lib;
