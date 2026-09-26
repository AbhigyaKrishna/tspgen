import { describe, expect, it } from "vitest";
import { camel, identifier, typeName, upperSnake } from "../src/naming.js";
import { kotlinString } from "../src/kotlin-string.js";

describe("kotlin naming", () => {
  it("camel-cases property and parameter names", () => {
    expect(camel("born_at")).toBe("bornAt");
    expect(camel("ID")).toBe("id");
    expect(camel("URLValue")).toBe("urlValue");
    expect(camel("Pet")).toBe("pet");
    expect(camel("page-size")).toBe("pageSize");
  });

  it("builds UPPER_SNAKE enum member names", () => {
    expect(upperSnake("notFound")).toBe("NOT_FOUND");
    expect(upperSnake("some-value")).toBe("SOME_VALUE");
    expect(upperSnake("HTTPError")).toBe("HTTP_ERROR");
    expect(upperSnake("1st")).toBe("V_1ST");
  });

  it("builds type names and escapes keywords", () => {
    expect(typeName("pet store")).toBe("PetStore");
    expect(typeName("2fa")).toBe("T2fa");
    expect(identifier("object")).toBe("`object`");
    expect(identifier("name")).toBe("name");
  });

  it("escapes Kotlin string literals", () => {
    expect(kotlinString(`a"b$c\\d\ne`)).toBe(`"a\\"b\\$c\\\\d\\ne"`);
  });
});
