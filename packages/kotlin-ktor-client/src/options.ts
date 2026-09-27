import { defineFeatures } from "@abhigyakrishna/tspgen-core";

export const ktorClientFeatures = defineFeatures({
  "ignore-unknown-keys": {
    default: true,
    description: "Ignore response fields the models don't declare (false: they fail decoding with SerializationException).",
  },
  "encode-defaults": {
    default: false,
    description: "Write properties equal to their default in request bodies (kotlinx's encodeDefaults).",
  },
  auth: {
    default: true,
    description: "Generate a <Service>Auth credential-provider parameter from @useAuth.",
  },
});

export type KtorClientFeatures = Record<keyof typeof ktorClientFeatures.defs, boolean>;

export interface KtorClientOptions {
  package?: string;
  "sse-max-size": number;
  /** On/off gates; every key is filled from its default by core's loadTargets. */
  features: KtorClientFeatures;
}

export const ktorClientOptionsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    package: { type: "string", description: 'Client package (default "<package>.client").' },
    "sse-max-size": {
      type: "integer",
      minimum: 1024,
      maximum: 2147483647,
      default: 1048576,
      description: "Longest server-sent event line and event data the client accepts, in bytes (MAX_SSE_SIZE); longer ones fail the stream.",
    },
  },
};
