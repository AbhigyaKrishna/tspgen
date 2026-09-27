import { describe, expect, it } from "vitest";
import { coreFeatures, defaultHeaderText, defineFeatures } from "../../src/index.js";
import { resolveHeaderText } from "../../src/pipeline/run-features.js";

const features = (configured: Record<string, unknown> = {}) => defineFeatures(coreFeatures).resolve(configured);

describe("resolveHeaderText", () => {
  it("is empty when features.header is false, regardless of header-text", () => {
    expect(resolveHeaderText(features({ header: false }), { "header-text": "Custom" }, "e")).toBe("");
  });

  it("uses header-text when it is a non-blank string", () => {
    expect(resolveHeaderText(features(), { "header-text": "Custom banner" }, "e")).toBe("Custom banner");
  });

  it("falls back to the emitter's default when header-text is absent", () => {
    expect(resolveHeaderText(features(), {}, "e")).toBe(defaultHeaderText("e"));
  });

  it("treats a blank header-text as unset", () => {
    expect(resolveHeaderText(features(), { "header-text": "" }, "e")).toBe(defaultHeaderText("e"));
  });

  it("treats a whitespace-only header-text as unset too", () => {
    expect(resolveHeaderText(features(), { "header-text": "   \n  " }, "e")).toBe(defaultHeaderText("e"));
  });
});
