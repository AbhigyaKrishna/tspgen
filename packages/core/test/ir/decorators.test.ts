import { describe, expect, it } from "vitest";
import { decoratorArg, decoratorArgs } from "../../src/index.js";

describe("decorator helpers", () => {
  const data = { "K.name": [["a"], ["b"]], "K.flag": [[true]] };

  it("returns the first argument of the last application when it is a string", () => {
    expect(decoratorArg(data, "K.name")).toBe("b");
    expect(decoratorArg(data, "K.flag")).toBeUndefined();
    expect(decoratorArg(undefined, "K.name")).toBeUndefined();
  });

  it("returns every string first argument", () => {
    expect(decoratorArgs(data, "K.name")).toEqual(["a", "b"]);
    expect(decoratorArgs(data, "missing")).toEqual([]);
  });
});
