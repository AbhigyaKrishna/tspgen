import type { ResolvedFeatures } from "@abhigyakrishna/tspgen-core";
import { goVersionSchema, MINIMUM_GO_VERSION } from "./version.js";

export { atLeastGo, goVersionSchema, MINIMUM_GO_VERSION } from "./version.js";

export interface GoNaming {
  initialisms?: string[];
  "enum-members"?: "PascalCase" | "UPPER_SNAKE";
  "operation-prefix"?: "group" | "none";
}

export interface GoOptions {
  goVersion: string;
  layout: "single-file" | "per-type" | "per-namespace";
  naming: GoNaming;
  typeNames: Record<string, string>;
  dateTime: "string" | "time.Time";
  decimal: "json.Number" | "string" | "float64";
  integer: "json.Number" | "int64";
  scalarStyle: "inline" | "alias";
  optionalFields: "pointers" | "values";
  omitEmpty: boolean;
  validation: boolean;
  validator: boolean;
  defaults: boolean;
  enumUnknown: boolean;
  features?: ResolvedFeatures<string>;
}

export const goOptionsSchemaProperties = {
  "go-version": goVersionSchema,
  layout: {
    type: "string",
    enum: ["single-file", "per-type", "per-namespace"],
    default: "single-file",
    description: "Models in one file, one file per type, or one file per TypeSpec namespace. All files belong to the configured models package.",
  },
  naming: {
    type: "object",
    additionalProperties: false,
    description: "Go identifier conventions. Exported identifiers use PascalCase; configured initialisms retain their uppercase spelling.",
    properties: {
      initialisms: { type: "array", default: [], uniqueItems: true, items: { type: "string", pattern: "^[A-Z][A-Z0-9]*$" } },
      "enum-members": { type: "string", enum: ["PascalCase", "UPPER_SNAKE"], default: "PascalCase" },
      "operation-prefix": { type: "string", enum: ["group", "none"], default: "group" },
    },
  },
  "type-names": {
    type: "object",
    additionalProperties: { type: "string", pattern: "^[A-Z][A-Za-z0-9_]*$" },
    default: {},
    description:
      "TypeSpec type id (e.g. Shop.Pet, or Shop.Maybe<int32> for a generic union instance), or unqualified type name, to exported Go name. Qualified entries take precedence.",
  },
  "date-time": {
    type: "string",
    enum: ["string", "time.Time"],
    default: "string",
    description: "Mapping of utcDateTime and offsetDateTime. time.Time uses Go's RFC 3339 JSON/text codecs; date, time and duration remain strings.",
  },
  decimal: {
    type: "string",
    enum: ["json.Number", "string", "float64"],
    default: "json.Number",
    description: "decimal/decimal128: exact JSON numeric text, JSON strings, or floating point (which can lose precision).",
  },
  integer: {
    type: "string",
    enum: ["json.Number", "int64"],
    default: "json.Number",
    description: "Unbounded integer scalar: exact JSON numeric text or signed 64-bit integers. Fixed-width scalars retain their declared width.",
  },
  "scalar-style": {
    type: "string",
    enum: ["inline", "alias"],
    default: "inline",
    description: "User scalar declarations inline their standard Go type or generate a named Go alias with the same wire codec.",
  },
  "optional-fields": {
    type: "string",
    enum: ["pointers", "values"],
    default: "pointers",
    description: "Optional model fields use pointers to preserve absence, or values with zero-value semantics. HTTP parameter request fields always preserve presence.",
  },
};

export function resolveGoOptions(options: Record<string, unknown>, features?: ResolvedFeatures<string>): GoOptions {
  return {
    goVersion: String(options["go-version"] ?? MINIMUM_GO_VERSION),
    layout: (options.layout as GoOptions["layout"]) ?? "single-file",
    naming: (options.naming as GoNaming) ?? {},
    typeNames: (options["type-names"] as Record<string, string>) ?? {},
    dateTime: (options["date-time"] as GoOptions["dateTime"]) ?? "string",
    decimal: (options.decimal as GoOptions["decimal"]) ?? "json.Number",
    integer: (options.integer as GoOptions["integer"]) ?? "json.Number",
    scalarStyle: (options["scalar-style"] as GoOptions["scalarStyle"]) ?? "inline",
    optionalFields: (options["optional-fields"] as GoOptions["optionalFields"]) ?? "pointers",
    omitEmpty: features?.values["omit-empty"] !== false,
    validation: features?.values.validation !== false,
    validator: features?.values.validator === true,
    defaults: features?.values.defaults !== false,
    enumUnknown: features?.values["enum-unknown"] === true,
    ...(features ? { features } : {}),
  };
}

export * from "./http/options.js";
