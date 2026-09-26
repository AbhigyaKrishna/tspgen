export interface KtorClientOptions {
  package?: string;
}

export const ktorClientOptionsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    package: { type: "string", description: 'Client package (default "<package>.client").' },
  },
};
