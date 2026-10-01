import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureRelativePrefix, relativeOutputPath } from "../../src/index.js";

const output = resolve("out", "client");

describe("output paths", () => {
  it.each([
    [output, ""],
    [resolve(output, "models"), "models"],
    [resolve(output, ".."), ".."],
    [resolve(output, "..", "shared", "雪 models"), "../shared/雪 models"],
  ])("makes %s relative to the target output directory", (models, expected) => {
    expect(relativeOutputPath(output, models)).toBe(expected);
  });

  it.each([
    ["models/pet", "./models/pet"],
    ["../shared/models", "../shared/models"],
    ["./models", "./models"],
    ["", "./"],
    [".", "."],
  ])("keeps a module path explicitly relative: %s", (path, expected) => {
    expect(ensureRelativePrefix(path)).toBe(expected);
  });
});
