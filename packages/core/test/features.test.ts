import { describe, expect, it } from "vitest";
import { coreFeatures, defineFeatures, mergeFeatures, overrideAllowed } from "../src/index.js";

const set = defineFeatures({
  plain: { default: true, description: "No override." },
  decl: { default: false, description: "Declaration override.", override: "declaration" },
  op: { default: true, description: "Operation override.", override: "operation" },
  model: { default: true, description: "Model override.", override: "model" },
});

describe("defineFeatures", () => {
  it("resolves definition defaults", () => {
    const features = set.resolve(undefined);
    expect(features.values).toEqual({ plain: true, decl: false, op: true, model: true });
    expect([...features.explicit]).toEqual([]);
  });

  it("applies configured booleans over defaults and remembers them as explicit", () => {
    const features = set.resolve({ plain: false, decl: false, op: "yes" });
    expect(features.values).toEqual({ plain: false, decl: false, op: true, model: true });
    expect([...features.explicit].sort()).toEqual(["decl", "plain"]);
  });

  it("reads @meta overrides only where the feature allows them", () => {
    const features = set.resolve({});
    const meta = { features: { plain: false, decl: true, op: false } };
    expect(features.at("plain", meta, "model")).toBe(true);
    expect(features.at("decl", meta, "model")).toBe(true);
    expect(features.at("decl", meta, "operation")).toBe(true);
    expect(features.at("op", meta, "model")).toBe(true);
    expect(features.at("op", meta, "enum")).toBe(true);
    expect(features.at("op", meta, "interface")).toBe(false);
    expect(features.at("op", meta, "operation")).toBe(false);
    expect(features.at("op", meta, "namespace")).toBe(false);
  });

  it("\"model\" override applies on namespaces and models, not on enums, unions, interfaces or operations", () => {
    const features = set.resolve({});
    const meta = { features: { model: false } };
    expect(features.at("model", meta, "model")).toBe(false);
    expect(features.at("model", meta, "namespace")).toBe(false);
    expect(features.at("model", meta, "enum")).toBe(true);
    expect(features.at("model", meta, "union")).toBe(true);
    expect(features.at("model", meta, "interface")).toBe(true);
    expect(features.at("model", meta, "operation")).toBe(true);
  });

  it("ignores missing and non-boolean @meta values", () => {
    const features = set.resolve({ decl: true });
    expect(features.at("decl", { features: { decl: "no" } }, "model")).toBe(true);
    expect(features.at("decl", { features: "off" }, "model")).toBe(true);
    expect(features.at("decl", {}, "model")).toBe(true);
  });

  it("ignores an array as meta.features (not a record)", () => {
    const features = set.resolve({ decl: true });
    expect(features.at("decl", { features: ["decl"] }, "model")).toBe(true);
  });

  it("ignores an array as resolve()'s input (not a record); every key falls back to its default", () => {
    const features = set.resolve(["plain", "decl"]);
    expect(features.values).toEqual({ plain: true, decl: false, op: true, model: true });
    expect([...features.explicit]).toEqual([]);
  });

  it("treats resolve(null) like resolve(undefined)", () => {
    const features = set.resolve(null);
    expect(features.values).toEqual({ plain: true, decl: false, op: true, model: true });
    expect([...features.explicit]).toEqual([]);
  });

  it("at() returns false for a key this set does not define", () => {
    const features = set.resolve({});
    expect(features.at("nope" as "plain", {}, "model")).toBe(false);
  });

  it("builds a closed schema for targets and an open one for language emitters", () => {
    const properties = {
      plain: { type: "boolean", default: true, description: "No override." },
      decl: { type: "boolean", default: false, description: "Declaration override." },
      op: { type: "boolean", default: true, description: "Operation override." },
      model: { type: "boolean", default: true, description: "Model override." },
    };
    expect(set.schema).toEqual({ type: "object", additionalProperties: false, default: {}, properties });
    expect(set.openSchema).toMatchObject({ type: "object", nullable: true, additionalProperties: true, properties });
  });
});

describe("mergeFeatures", () => {
  it("lets the second set win on a clash, including explicit tracking", () => {
    const language = defineFeatures({
      a: { default: true, description: "a" },
      b: { default: true, description: "b" },
    }).resolve({ a: false, b: false });
    const target = defineFeatures({
      b: { default: true, description: "b" },
      c: { default: false, description: "c" },
    }).resolve({});
    const merged = mergeFeatures(language, target);
    expect(merged.values).toEqual({ a: false, b: true, c: false });
    expect([...merged.explicit]).toEqual(["a"]);
    expect(Object.keys(merged.defs).sort()).toEqual(["a", "b", "c"]);
  });

  it("at() on a clashing key uses the over-set's override level, not the base's", () => {
    const base = defineFeatures({
      x: { default: true, description: "x", override: "operation" },
    }).resolve({});
    const over = defineFeatures({
      x: { default: true, description: "x", override: "declaration" },
    }).resolve({});
    const merged = mergeFeatures(base, over);
    // "declaration" (over's level) allows overriding on a model; "operation" (base's level) would not.
    expect(merged.at("x", { features: { x: false } }, "model")).toBe(false);
  });
});

describe("coreFeatures", () => {
  it("declares header, docs, api-version and generics", () => {
    expect(defineFeatures(coreFeatures).resolve(undefined).values).toEqual({
      header: true,
      docs: true,
      "api-version": true,
      generics: true,
    });
    expect(overrideAllowed(coreFeatures.docs, "model")).toBe(true);
    expect(overrideAllowed(coreFeatures.docs, "interface")).toBe(true);
    expect(overrideAllowed(coreFeatures.generics, "namespace")).toBe(true);
    expect(overrideAllowed(coreFeatures.generics, "model")).toBe(true);
    // "model" override: an enum, union, interface or operation may not override generics.
    expect(overrideAllowed(coreFeatures.generics, "enum")).toBe(false);
    expect(overrideAllowed(coreFeatures.generics, "union")).toBe(false);
    expect(overrideAllowed(coreFeatures.generics, "interface")).toBe(false);
    expect(overrideAllowed(coreFeatures.generics, "operation")).toBe(false);
    expect(overrideAllowed(coreFeatures.header, "namespace")).toBe(false);
    expect(overrideAllowed(coreFeatures["api-version"], "operation")).toBe(false);
  });
});
