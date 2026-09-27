import { defineFeatures, type MovedOptions } from "@abhigyakrishna/tspgen-core";

export const ktorServerFeatures = defineFeatures({
  module: { default: true, description: "<Service>Module.kt: content negotiation, StatusPages and routing." },
  auth: {
    default: true,
    description: "Wrap routes in authenticate(...) per the operations' @useAuth (off: only the authenticate/wrap meta keys).",
  },
  "call-access": { default: false, description: "Pass the ApplicationCall to handlers." },
  "nest-routes": {
    default: false,
    description: "Nest each route function under its operations' common path prefix (dsl style).",
  },
});

export type KtorServerFeatures = Record<keyof typeof ktorServerFeatures.defs, boolean>;

/** Ktor server option keys moved in 0.2.0. */
export const ktorServerMovedOptions: MovedOptions = {
  module: "features.module",
  "generate-auth": "features.auth",
  "call-access": "features.call-access",
  "nest-routes": "features.nest-routes",
};

export interface KtorServerOptions {
  "routing-style": string;
  grouping: "per-interface" | "per-namespace" | "single-file";
  "handler-shape": "params" | "request-object";
  "service-suffix": string;
  multipart: "buffered" | "streaming" | "raw";
  "max-upload-size": number;
  "auth-providers": Record<string, string>;
  sse: "text-writer" | "plugin";
  package?: string;
  /** On/off gates; every key is filled from its default. */
  features: KtorServerFeatures;
}

export const ktorServerOptionsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    "routing-style": {
      type: "string",
      default: "dsl",
      description: "dsl | resources | a style registered by a plugin",
    },
    grouping: {
      type: "string",
      enum: ["per-interface", "per-namespace", "single-file"],
      default: "per-interface",
      description:
        "How operations are grouped into service interfaces and route files: per-interface (default, one per TypeSpec interface), per-namespace (one per enclosing namespace) or single-file (every operation in one).",
    },
    "handler-shape": {
      type: "string",
      enum: ["params", "request-object"],
      default: "params",
      description:
        "Shape of generated service methods' parameters: params (default, one Kotlin parameter per path/query/header/body field) or request-object (the operation's fields bundled into one generated <Op>Request data class parameter).",
    },
    "service-suffix": { type: "string", default: "Service", description: 'Service interface suffix (e.g. "Api").' },
    multipart: {
      type: "string",
      enum: ["buffered", "streaming", "raw"],
      default: "buffered",
      description:
        'How multipart and file bodies reach the service: buffered (HttpFile / request class), streaming (Flow of parts / ByteReadChannel) or raw (MultiPartData / ByteReadChannel); per operation via @meta("kotlin:ktor-server", #{ multipart }).',
    },
    "max-upload-size": {
      type: "integer",
      minimum: 1,
      default: 52428800,
      description:
        'Largest multipart part and buffered file body, in bytes (default 50 MiB, Ktor\'s formFieldLimit); larger ones answer 413. Per operation via @meta("kotlin:ktor-server", #{ maxUploadSize }).',
    },
    "auth-providers": {
      type: "object",
      additionalProperties: { type: "string", minLength: 1 },
      default: {},
      description:
        'Auth scheme id → Kotlin expression naming its Ktor authentication provider (e.g. { BearerAuth: "JWT_AUTH" }); unmapped ids are used as string literals.',
    },
    sse: {
      type: "string",
      enum: ["text-writer", "plugin"],
      default: "text-writer",
      description:
        'How server-sent event streams are written: text-writer (respondBytesWriter, no extra dependency) or plugin (the ktor-server-sse plugin, installed by the module); per operation via @meta("kotlin:ktor-server", #{ sse }).',
    },
    package: { type: "string", description: 'Server package (default "<package>.server").' },
  },
};
