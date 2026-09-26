export interface KtorServerOptions {
  "routing-style": string;
  grouping: "per-interface" | "per-namespace" | "single-file";
  "handler-shape": "params" | "request-object";
  "call-access": boolean;
  "service-suffix": string;
  module: boolean;
  "nest-routes": boolean;
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
    package: { type: "string", description: 'Server package (default "<package>.server").' },
  },
};
