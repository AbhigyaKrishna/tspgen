import { expectDiagnostics } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { checkMovedOptions, movedOptionSchemas } from "../src/index.js";
import { Tester } from "./tester.js";

describe("moved options", () => {
  it("reports each moved key with its new location", async () => {
    const { program } = await Tester.compile(`model M {}`);
    expect(checkMovedOptions(program, { zod: true, layout: "per-type" }, { zod: "features.zod" })).toBe(false);
    expectDiagnostics(program.diagnostics, {
      code: "@abhigyakrishna/tspgen-core/option-moved",
      severity: "error",
      message: "`zod` moved to `features.zod` in 0.2.0.",
    });
  });

  it("passes options without moved keys", async () => {
    const { program } = await Tester.compile(`model M {}`);
    expect(checkMovedOptions(program, { layout: "per-type" }, { zod: "features.zod" })).toBe(true);
    expect(program.diagnostics).toEqual([]);
  });

  it("keeps moved keys in emitter schemas as accept-anything properties", () => {
    expect(movedOptionSchemas({ zod: "features.zod" })).toEqual({ zod: { description: "Moved to features.zod in 0.2.0." } });
  });
});
