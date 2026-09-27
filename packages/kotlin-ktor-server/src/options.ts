export interface KtorServerOptions {
  "routing-style": string;
  grouping: "per-interface" | "per-namespace" | "single-file";
  "handler-shape": "params" | "request-object";
  "call-access": boolean;
  "service-suffix": string;
  module: boolean;
  "nest-routes": boolean;
  multipart: "buffered" | "streaming" | "raw";
  "max-upload-size": number;
  package?: string;
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
    grouping: { type: "string", enum: ["per-interface", "per-namespace", "single-file"], default: "per-interface" },
    "handler-shape": { type: "string", enum: ["params", "request-object"], default: "params" },
    "call-access": { type: "boolean", default: false },
    "service-suffix": { type: "string", default: "Service", description: 'Service interface suffix (e.g. "Api").' },
    module: { type: "boolean", default: true, description: "Emit <Service>Module.kt (JSON, StatusPages, routing)." },
    "nest-routes": {
      type: "boolean",
      default: false,
      description: "Nest each route function under its operations' common path prefix (dsl style).",
    },
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
    package: { type: "string", description: 'Server package (default "<package>.server").' },
  },
};
