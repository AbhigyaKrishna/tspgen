import { defineFeatures, type ResolvedFeatures } from "@abhigyakrishna/tspgen-core";
import type { TargetContext } from "@abhigyakrishna/tspgen-core";
import type { GoIR } from "./transform.js";

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
  defaults: boolean;
  enumUnknown: boolean;
  features?: ResolvedFeatures<string>;
}

export const goVersionSchema = {
  type: "string", pattern: "^1\\.[0-9]+(?:\\.[0-9]+)?$", default: "1.22",
  description: "Minimum Go language/toolchain version written to go.mod (1.22 or newer). Targets inherit it, subject to their runtime minimum; generic client methods require 1.27 or newer.",
};

export const goOptionsSchemaProperties = {
  "go-version": goVersionSchema,
  layout: { type: "string", enum: ["single-file", "per-type", "per-namespace"], default: "single-file", description: "Models in one file, one file per type, or one file per TypeSpec namespace. All files belong to the configured models package." },
  naming: {
    type: "object", additionalProperties: false, description: "Go identifier conventions. Exported identifiers use PascalCase; configured initialisms retain their uppercase spelling.",
    properties: {
      initialisms: { type: "array", default: [], uniqueItems: true, items: { type: "string", pattern: "^[A-Z][A-Z0-9]*$" } },
      "enum-members": { type: "string", enum: ["PascalCase", "UPPER_SNAKE"], default: "PascalCase" },
      "operation-prefix": { type: "string", enum: ["group", "none"], default: "group" },
    },
  },
  "type-names": { type: "object", additionalProperties: { type: "string", pattern: "^[A-Z][A-Za-z0-9_]*$" }, default: {}, description: "TypeSpec type id (e.g. Shop.Pet), or unqualified type name, to exported Go name. Qualified entries take precedence." },
  "date-time": { type: "string", enum: ["string", "time.Time"], default: "string", description: "Mapping of utcDateTime and offsetDateTime. time.Time uses Go's RFC 3339 JSON/text codecs; date, time and duration remain strings." },
  decimal: { type: "string", enum: ["json.Number", "string", "float64"], default: "json.Number", description: "decimal/decimal128: exact JSON numeric text, JSON strings, or floating point (which can lose precision)." },
  integer: { type: "string", enum: ["json.Number", "int64"], default: "json.Number", description: "Unbounded integer scalar: exact JSON numeric text or signed 64-bit integers. Fixed-width scalars retain their declared width." },
  "scalar-style": { type: "string", enum: ["inline", "alias"], default: "inline", description: "User scalar declarations inline their standard Go type or generate a named Go alias with the same wire codec." },
  "optional-fields": { type: "string", enum: ["pointers", "values"], default: "pointers", description: "Optional model fields use pointers to preserve absence, or values with zero-value semantics. HTTP parameter request fields always preserve presence." },
};

export function resolveGoOptions(options: Record<string, unknown>, features?: ResolvedFeatures<string>): GoOptions {
  return {
    goVersion: String(options["go-version"] ?? "1.22"),
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
    defaults: features?.values.defaults !== false,
    enumUnknown: features?.values["enum-unknown"] === true,
    ...(features ? { features } : {}),
  };
}

export function atLeastGo(version: string, minimum: string): boolean {
  const actual = version.split(".").map(Number);
  const required = minimum.split(".").map(Number);
  for (let i = 0; i < Math.max(actual.length, required.length); i++) {
    const diff = (actual[i] ?? 0) - (required[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

export interface GoHTTPOptions {
  module: string;
  package?: string;
  "go-version"?: string;
  grouping?: "single-file" | "per-interface" | "per-namespace";
  "request-suffix"?: string;
  errors?: "raw" | "typed";
}

export interface GoClientOptions extends GoHTTPOptions {
  "client-name"?: string;
  "max-response-size"?: number;
  "timeout-ms"?: number;
}

export interface GoServerOptions extends GoHTTPOptions {
  "service-name"?: string;
  "handler-shape"?: "request-object" | "params";
  "max-body-size"?: number;
  "error-body"?: "json" | "problem" | "none";
}

export const goHTTPOptionsSchemaProperties = {
  module: { type: "string", description: "Import path of this generated Go module; must differ from the models module." },
  package: { type: "string", description: "Go package name (default client or server, depending on the target)." },
  "go-version": { ...goVersionSchema, default: undefined, description: "Target Go version; inherits the models version, with the target's runtime minimum applied. Explicit values must satisfy both minima." },
  grouping: { type: "string", enum: ["single-file", "per-interface", "per-namespace"], default: "single-file", description: "Organize operation declarations and implementations into one file, or files per TypeSpec interface/namespace. Files stay in one Go package." },
  "request-suffix": { type: "string", pattern: "^[A-Z][A-Za-z0-9_]*$", default: "Request", description: "Suffix on generated operation request struct names." },
  errors: { type: "string", enum: ["raw", "typed"], default: "raw", description: "Raw HTTPError or additional typed errors for the operations' declared error response bodies." },
};

const wireFeatures = {
  "go-mod": { default: true, description: "Generate this target's go.mod with its runtime dependencies and a local models replace directive." },
  "encode-defaults": { default: false, description: "Include optional properties equal to their declared default and unset optional properties as null in emitted JSON." },
  "explicit-nulls": { default: true, description: "Include nullable model properties whose value is null; false omits null struct properties (including required nullable ones)." },
};

export const goClientFeatures = defineFeatures({
  ...wireFeatures,
  "client-constructor": { default: true, description: "Generate NewClient (or New<client-name>) to construct a client with its configured defaults." },
  "generic-methods": { default: false, description: "Generate Client.Do[T any] and call it from typed endpoint methods. Requires an effective go-version of at least 1.27." },
  validate: { default: false, description: "Validate request values before sending and response JSON after decoding (requires models features.validation)." },
  "ignore-unknown-keys": { default: true, description: "Accept response JSON properties the models do not declare; false rejects them." },
});

export const goServerFeatures = defineFeatures({
  ...wireFeatures,
  handler: { default: true, description: "Generate NewHandler; RegisterRoutes is always available for application-owned routers and middleware." },
  "call-access": { default: false, description: "Pass the underlying *http.Request or *gin.Context to service methods, after context.Context." },
  validate: { default: true, description: "Validate decoded request bodies and parameter constraints (requires models features.validation)." },
  "ignore-unknown-keys": { default: false, description: "Accept request JSON properties the models do not declare; false rejects them." },
});

export const goClientOptionsSchema = {
  type: "object", additionalProperties: false, required: ["module"],
  properties: {
    ...goHTTPOptionsSchemaProperties,
    package: { ...goHTTPOptionsSchemaProperties.package, default: "client" },
    "client-name": { type: "string", pattern: "^[A-Z][A-Za-z0-9_]*$", default: "Client", description: "Name of the generated client struct and its constructor." },
    "max-response-size": { type: "integer", minimum: 1, maximum: 2147483647, default: 1048576, description: "Maximum response body size in bytes, for both successes and errors. Larger responses fail without silently truncating the body." },
    "timeout-ms": { type: "integer", minimum: 0, maximum: 2147483647, default: 0, description: "Timeout in milliseconds when no custom HTTPClient is supplied; 0 uses http.DefaultClient." },
  },
};

export const goServerOptionsSchema = {
  type: "object", additionalProperties: false, required: ["module"],
  properties: {
    ...goHTTPOptionsSchemaProperties,
    package: { ...goHTTPOptionsSchemaProperties.package, default: "server" },
    "service-name": { type: "string", pattern: "^[A-Z][A-Za-z0-9_]*$", default: "Service", description: "Name of the service interface. Grouped output also generates embedded interfaces for each group." },
    "handler-shape": { type: "string", enum: ["request-object", "params"], default: "request-object", description: "Service methods receive a typed request struct or individual path/query/header/body arguments." },
    "max-body-size": { type: "integer", minimum: 1, maximum: 2147483647, default: 1048576, description: "Maximum request body size in bytes; larger bodies receive HTTP 413." },
    "error-body": { type: "string", enum: ["json", "problem", "none"], default: "json", description: "Fallback error response: JSON {error}, RFC 9457 application/problem+json, or an empty body. Explicit service error bodies are preserved." },
  },
};

export function effectiveGoVersion(irVersion: string, options: GoHTTPOptions, minimum: string): string {
  const version = options["go-version"] ?? (atLeastGo(irVersion, minimum) ? irVersion : minimum);
  if (!/^1\.[0-9]+(?:\.[0-9]+)?$/.test(version) || !atLeastGo(version, minimum) || !atLeastGo(version, irVersion))
    throw new Error(`go-version ${version} must be at least Go ${atLeastGo(irVersion, minimum) ? irVersion : minimum}.`);
  return version;
}

export function wireOptions(ctx: TargetContext, ir: GoIR): { ignoreUnknown: boolean; validate: boolean; defaults: boolean; encodeDefaults: boolean; explicitNulls: boolean } {
  return {
    ignoreUnknown: ctx.features.values["ignore-unknown-keys"] === true,
    validate: (ir.options.validation || ir.declarations.some((d) => d.kind === "struct" && d.validation)) && ctx.features.values.validate === true,
    defaults: ir.options.defaults || ir.declarations.some((d) => d.kind === "struct" && d.defaults),
    encodeDefaults: ctx.features.values["encode-defaults"] === true,
    explicitNulls: ctx.features.values["explicit-nulls"] !== false,
  };
}
