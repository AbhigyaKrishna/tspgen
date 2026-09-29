import {
  coreEmitterOptionsSchemaProperties,
  coreFeatures,
  defaultHeaderText,
  defineFeatures,
  type LanguageEmitterOptions,
} from "@abhigyakrishna/tspgen-core";
import { createTypeSpecLibrary, paramMessage, type JSONSchemaType } from "@typespec/compiler";

export const GO_EMITTER = "@abhigyakrishna/tspgen-go";
export const goFeatures = defineFeatures({ ...coreFeatures });

export interface GoEmitterOptions extends LanguageEmitterOptions {
  module: string;
  package?: string;
}

const optionsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...coreEmitterOptionsSchemaProperties,
    "header-text": { ...coreEmitterOptionsSchemaProperties["header-text"], default: defaultHeaderText(GO_EMITTER) },
    features: goFeatures.openSchema,
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
