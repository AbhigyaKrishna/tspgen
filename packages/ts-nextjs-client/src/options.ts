export interface NextClientOptions {
  "react-query": boolean;
  "server-actions": boolean;
  "base-url-env": string;
}

export const nextClientOptionsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    "react-query": { type: "boolean", default: true, description: "Emit TanStack Query keys, queryOptions and hooks." },
    "server-actions": { type: "boolean", default: true, description: "Emit Server Actions for non-GET operations." },
    "base-url-env": {
      type: "string",
      default: "API_BASE_URL",
      description: "Environment variable holding the API base URL for Server Actions.",
    },
  },
};
