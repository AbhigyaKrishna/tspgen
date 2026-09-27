import { defineFeatures, type MovedOptions } from "@abhigyakrishna/tspgen-core";

export const nextClientFeatures = defineFeatures({
  "server-actions": { default: true, description: "Server Actions for non-GET operations (grouped style only)." },
  "react-query": {
    default: true,
    description: "TanStack Query keys, queryOptions and hooks (flat style: queries.ts + hooks.ts); needs @tanstack/react-query.",
  },
  validate: {
    default: true,
    description:
      "Flat style: check request bodies, query objects and constrained path parameters with zod before fetch; needs features.zod on the TypeScript emitter.",
  },
});

export type NextClientFeatures = Record<keyof typeof nextClientFeatures.defs, boolean>;

/** Next.js client option keys moved in 0.2.0. */
export const nextClientMovedOptions: MovedOptions = {
  "react-query": "features.react-query",
  "server-actions": "features.server-actions",
  validate: "features.validate",
};

export interface NextClientOptions {
  "base-url-env": string;
  "client-style": "grouped" | "flat";
  "error-class": string;
  "error-model"?: string;
  /** On/off gates; every key is filled from its default. */
  features: NextClientFeatures;
}

export const nextClientOptionsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
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
