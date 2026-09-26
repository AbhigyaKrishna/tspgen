export interface NextClientOptions {
  /** Grouped style only; defaults to true there. */
  "react-query"?: boolean;
  /** Grouped style only; defaults to true there. */
  "server-actions"?: boolean;
  "base-url-env": string;
  "client-style": "grouped" | "flat";
  "error-class": string;
  "error-model"?: string;
}

export const nextClientOptionsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    "react-query": { type: "boolean", description: "Emit TanStack Query keys, queryOptions and hooks (grouped; default true)." },
    "server-actions": { type: "boolean", description: "Emit Server Actions for non-GET operations (grouped; default true)." },
    "base-url-env": {
      type: "string",
      default: "API_BASE_URL",
      description: "Environment variable holding the API base URL for Server Actions.",
    },
    "client-style": {
      type: "string",
      enum: ["grouped", "flat"],
      default: "grouped",
      description: "grouped: client/ with per-group classes, hooks, actions; flat: client.ts with one class.",
    },
    "error-class": { type: "string", default: "ApiError", description: "Error class of the flat client." },
    "error-model": {
      type: "string",
      description: "Model (TypeScript name or TypeSpec id) whose fields the flat client's error class exposes.",
    },
  },
};
