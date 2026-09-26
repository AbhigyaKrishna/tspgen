import { describe, expect, it } from "vitest";
import { renderImports } from "../src/imports.js";
import { camel, memberName, propertyKey, typeName } from "../src/naming.js";

describe("typescript naming", () => {
  it("builds identifiers", () => {
    expect(typeName("pet store")).toBe("PetStore");
    expect(typeName("2fa")).toBe("T2fa");
    expect(camel("page-size")).toBe("pageSize");
    expect(camel("ID")).toBe("id");
    expect(memberName("dark-blue")).toBe("DarkBlue");
    expect(memberName("1st")).toBe("V1st");
  });

  it("quotes property keys that are not identifiers", () => {
    expect(propertyKey("born_at")).toBe("born_at");
    expect(propertyKey("$ref")).toBe("$ref");
    expect(propertyKey("x-meta")).toBe(`"x-meta"`);
  });
});

describe("renderImports", () => {
  it("groups by module, splits value and type imports, orders external first", () => {
    const lines = renderImports(
      "models/Pet",
      [
        { name: "Owner", from: "models/Owner", typeOnly: true },
        { name: "OwnerSchema", from: "models/Owner", typeOnly: false },
        { name: "z", from: "zod", typeOnly: false, external: true },
        { name: "Pet", from: "models/Pet", typeOnly: true },
        { name: "HttpError", from: "api/errors", typeOnly: false },
        { name: "Owner", from: "models/Owner", typeOnly: true },
      ],
      "",
    );
    expect(lines).toEqual([
      `import { z } from "zod";`,
      `import { HttpError } from "../api/errors";`,
      `import { OwnerSchema } from "./Owner";`,
      `import type { Owner } from "./Owner";`,
    ]);
  });

  it("appends the import extension to relative specifiers", () => {
    expect(renderImports("client/pets", [{ name: "Pet", from: "models/Pet", typeOnly: true }], ".js")).toEqual([
      `import type { Pet } from "../models/Pet.js";`,
    ]);
  });
});
