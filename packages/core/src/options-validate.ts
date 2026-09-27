import { Ajv } from "ajv";

const ajv = new Ajv({ useDefaults: true, allErrors: true, strict: false });

/**
 * Message for one ajv error: its own `message`, except `additionalProperties` (whose message never names the
 * key) names the offending key from `params.additionalProperty` (e.g. `must NOT have additional property 'foo'`).
 */
function errorMessage(e: { keyword: string; message?: string; params: Record<string, unknown> }): string {
  if (e.keyword === "additionalProperties" && typeof e.params.additionalProperty === "string") {
    return `must NOT have additional property '${e.params.additionalProperty}'`;
  }
  return e.message ?? "is invalid";
}

/** Validate `value` against `schema`, filling declared defaults in place. Returns error messages. */
export function validateOptions(schema: object, value: Record<string, unknown>): string[] {
  const validate = ajv.compile(schema);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${errorMessage(e)}`);
}
