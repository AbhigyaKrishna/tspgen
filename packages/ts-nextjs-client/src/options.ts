import { defineFeatures, type MovedOptions } from "@abhigyakrishna/tspgen-core";

export const nextClientFeatures = defineFeatures({
  "server-actions": { default: true, description: "Server Actions for non-GET operations (grouped style only)." },
  "server-only": {
    default: true,
    description:
      'Grouped style: `import "server-only"` at the top of client/actions/server-client.ts, so importing it from a Client Component fails the Next.js build (needs server-actions).',
  },
  "react-query": {
    default: true,
    description: "TanStack Query keys, queryOptions and hooks (flat style: queries.ts + hooks.ts); needs @tanstack/react-query.",
  },
  hooks: {
    default: true,
    description:
      "hooks.ts: React context, <Service>ClientProvider, use<Service>Client and the query/mutation hooks. false keeps only the server-safe queries.ts (needs react-query).",
  },
  validate: {
    default: true,
    description:
      "Flat style: check request bodies, query objects and constrained path parameters with zod before fetch; needs features.zod on the TypeScript emitter.",
  },
  "error-getters": {
    default: true,
    description: "Flat style: isUnauthorized/isForbidden/isNotFound/isConflict getters on the error class.",
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
  /** Default: `<Service>Error` (see flatErrorClassName). */
  "error-class"?: string;
  "error-model"?: string;
  /** React Query: first element of every generated query key. */
  "query-key-prefix"?: string;
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
    "error-class": {
      type: "string",
      description:
        'Error class of the flat client (default "<Service>Error", after the first service when there are several).',
    },
    "error-model": {
      type: "string",
      description: "Model (TypeScript name or TypeSpec id) whose fields the flat client's error class exposes.",
    },
    "query-key-prefix": {
      type: "string",
      description: 'React Query: prepended as the first element of every generated query key (e.g. "api" → ["api", "PetStore", …]).',
    },
  },
};
