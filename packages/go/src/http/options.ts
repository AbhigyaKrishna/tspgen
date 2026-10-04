import { defineFeatures, type TargetContext } from "@abhigyakrishna/tspgen-core";
import { atLeastGo, goVersionSchema, supportedGoVersion } from "../version.js";
import type { GoIR } from "../transform/model.js";

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
  module: {
    type: "string",
    description: "Import path of this generated Go module; must differ from the models module.",
  },
  package: {
    type: "string",
    description: "Go package name (default client or server, depending on the target).",
  },
  "go-version": {
    ...goVersionSchema,
    default: undefined,
    description: "Target Go version; inherits the models version, with the target's runtime minimum applied. Explicit values must satisfy both minima.",
  },
  grouping: {
    type: "string",
    enum: ["single-file", "per-interface", "per-namespace"],
    default: "single-file",
    description: "Organize operation declarations and implementations into one file, or files per TypeSpec interface/namespace. Files stay in one Go package.",
  },
  "request-suffix": {
    type: "string",
    pattern: "^[A-Z][A-Za-z0-9_]*$",
    default: "Request",
    description: "Suffix on generated operation request struct names.",
  },
  errors: {
    type: "string",
    enum: ["raw", "typed"],
    default: "raw",
    description: "Raw HTTPError or additional typed errors for the operations' declared error response bodies.",
  },
};

const wireFeatures = {
  "go-mod": {
    default: true,
    description: "Generate this target's go.mod with its runtime dependencies and a local models replace directive.",
  },
  "encode-defaults": {
    default: false,
    description: "Include optional properties equal to their declared default and unset optional properties as null in emitted JSON.",
  },
  "explicit-nulls": {
    default: true,
    description: "Include nullable model properties whose value is null; false omits null struct properties (including required nullable ones).",
  },
};

export const goClientFeatures = defineFeatures({
  ...wireFeatures,
  "client-constructor": {
    default: true,
    description: "Generate NewClient (or New<client-name>) to construct a client with its configured defaults.",
  },
  "generic-methods": {
    default: false,
    description: "Generate Client.Do[T any] and call it from typed endpoint methods. Requires an effective go-version of at least 1.27.",
  },
  validate: {
    default: false,
    description: "Validate request values before sending and response JSON after decoding (requires models features.validation).",
  },
  "ignore-unknown-keys": {
    default: true,
    description: "Accept response JSON properties the models do not declare; false rejects them.",
  },
});

export const goServerFeatures = defineFeatures({
  ...wireFeatures,
  handler: {
    default: true,
    description: "Generate NewHandler; RegisterRoutes is always available for application-owned routers and middleware.",
  },
  "call-access": {
    default: false,
    description: "Pass the underlying *http.Request or *gin.Context to service methods, after context.Context.",
  },
  validate: {
    default: true,
    description: "Validate decoded request bodies and parameter constraints (requires models features.validation).",
  },
  "ignore-unknown-keys": {
    default: false,
    description: "Accept request JSON properties the models do not declare; false rejects them.",
  },
});

export const goClientOptionsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["module"],
  properties: {
    ...goHTTPOptionsSchemaProperties,
    package: { ...goHTTPOptionsSchemaProperties.package, default: "client" },
    "client-name": {
      type: "string",
      pattern: "^[A-Z][A-Za-z0-9_]*$",
      default: "Client",
      description: "Name of the generated client struct and its constructor.",
    },
    "max-response-size": {
      type: "integer",
      minimum: 1,
      maximum: 2147483647,
      default: 1048576,
      description: "Maximum response body size in bytes, for both successes and errors. Larger responses fail without silently truncating the body.",
    },
    "timeout-ms": {
      type: "integer",
      minimum: 0,
      maximum: 2147483647,
      default: 0,
      description: "Timeout in milliseconds when no custom HTTPClient is supplied; 0 uses http.DefaultClient.",
    },
  },
};

export const goServerOptionsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["module"],
  properties: {
    ...goHTTPOptionsSchemaProperties,
    package: { ...goHTTPOptionsSchemaProperties.package, default: "server" },
    "service-name": {
      type: "string",
      pattern: "^[A-Z][A-Za-z0-9_]*$",
      default: "Service",
      description: "Name of the service interface. Grouped output also generates embedded interfaces for each group.",
    },
    "handler-shape": {
      type: "string",
      enum: ["request-object", "params"],
      default: "request-object",
      description: "Service methods receive a typed request struct or individual path/query/header/body arguments.",
    },
    "max-body-size": {
      type: "integer",
      minimum: 1,
      maximum: 2147483647,
      default: 1048576,
      description: "Maximum request body size in bytes; larger bodies receive HTTP 413.",
    },
    "error-body": {
      type: "string",
      enum: ["json", "problem", "none"],
      default: "json",
      description: "Fallback error response: JSON {error}, RFC 9457 application/problem+json, or an empty body. Explicit service error bodies are preserved.",
    },
  },
};

export function effectiveGoVersion(irVersion: string, options: GoHTTPOptions, minimum: string): string {
  const requiredVersion = atLeastGo(irVersion, minimum) ? irVersion : minimum;
  const version = options["go-version"] ?? requiredVersion;
  if (!supportedGoVersion(version, minimum, irVersion)) {
    throw new Error(`go-version ${version} must be at least Go ${requiredVersion}.`);
  }
  return version;
}

export interface GoWireOptions {
  ignoreUnknown: boolean;
  validate: boolean;
  defaults: boolean;
  encodeDefaults: boolean;
  explicitNulls: boolean;
}

export function wireOptions(ctx: TargetContext, ir: GoIR): GoWireOptions {
  const hasValidation = ir.options.validation
    || ir.declarations.some((decl) => (decl.kind === "struct" || decl.kind === "union") && decl.validation);
  const hasDefaults = ir.options.defaults || ir.declarations.some((decl) => decl.kind === "struct" && decl.defaults);
  return {
    ignoreUnknown: ctx.features.values["ignore-unknown-keys"] === true,
    validate: hasValidation && ctx.features.values.validate === true,
    defaults: hasDefaults,
    encodeDefaults: ctx.features.values["encode-defaults"] === true,
    explicitNulls: ctx.features.values["explicit-nulls"] !== false,
  };
}
