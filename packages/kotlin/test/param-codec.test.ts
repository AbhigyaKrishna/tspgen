import { describe, expect, it } from "vitest";
import { listElement, listOf, nullable, paramDecode, paramEncode, scalarTypeUse } from "../src/index.js";

describe("parameter codecs", () => {
  it("parse and write primitives, strings, java.time and kotlinx-encoded types", () => {
    const long = scalarTypeUse("int64");
    expect(paramDecode("it", long)).toBe("it.toLong()");
    expect(paramDecode("it", nullable(long))).toBe("it.toLong()");
    expect(paramEncode("x", nullable(long))).toBe("x.toString()");
    expect(paramDecode("it", scalarTypeUse("string"))).toBe("it");
    expect(paramEncode("x", scalarTypeUse("string"))).toBe("x");
    const instant = scalarTypeUse("utcDateTime", "java.time");
    expect(paramDecode("raw", instant)).toBe("Instant.parse(raw)");
    expect(paramEncode("x", instant)).toBe("x.toString()");
    const pet = { text: "Pet", imports: ["com.acme.models.Pet"], nullable: false };
    expect(paramDecode("it", pet)).toBe("decodeParam<Pet>(it)");
    expect(paramEncode("x", pet)).toBe("encodeParam(x)");
  });

  it("find list elements from listOf, else from the text", () => {
    expect(listElement(nullable(listOf(scalarTypeUse("int32"))))).toMatchObject({ text: "Int", nullable: false });
    expect(listElement({ text: "List<Foo>", imports: ["a.Foo"], nullable: false })).toEqual({ text: "Foo", imports: ["a.Foo"], nullable: false });
    expect(listElement(scalarTypeUse("string"))).toBeUndefined();
  });
});
