import { Ajv } from "ajv";

const ajv = new Ajv({ useDefaults: true, allErrors: true, strict: false });

/** Validate `value` against `schema`, filling declared defaults in place. Returns error messages. */
export function validateOptions(schema: object, value: Record<string, unknown>): string[] {
  const validate = ajv.compile(schema);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`);
}
