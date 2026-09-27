import { describe, expect, it } from "vitest";
import { validateOptions } from "../src/index.js";

describe("validateOptions", () => {
  it("names the offending key in an additionalProperties error", () => {
    const schema = { type: "object", additionalProperties: false, properties: { style: { type: "string" } } };
    const errors = validateOptions(schema, { foo: true });
    expect(errors).toEqual(["/ must NOT have additional property 'foo'"]);
  });

  it("names the offending key of a nested additionalProperties error (e.g. under features)", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { features: { type: "object", additionalProperties: false, properties: { docs: { type: "boolean" } } } },
    };
    const errors = validateOptions(schema, { features: { docs: true, nope: true } });
    expect(errors).toEqual(["/features must NOT have additional property 'nope'"]);
  });

  it("still falls back to ajv's own message for other error kinds", () => {
    const schema = { type: "object", properties: { style: { type: "string" } } };
    const errors = validateOptions(schema, { style: 5 });
    expect(errors).toEqual(["/style must be string"]);
  });

  it("fills declared defaults in place and returns no errors when the value is valid", () => {
    const schema = { type: "object", properties: { style: { type: "string", default: "a" } } };
    const value: Record<string, unknown> = {};
    expect(validateOptions(schema, value)).toEqual([]);
    expect(value).toEqual({ style: "a" });
  });
});
