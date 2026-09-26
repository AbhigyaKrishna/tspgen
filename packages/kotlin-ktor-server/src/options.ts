export interface KtorServerOptions {
  "routing-style": string;
  grouping: "per-interface" | "per-namespace" | "single-file";
  "handler-shape": "params" | "request-object";
  "call-access": boolean;
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
    package: { type: "string", description: 'Server package (default "<package>.server").' },
  },
};
