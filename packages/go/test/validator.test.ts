import { createTester } from "@typespec/compiler/testing";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runGo } from "./helpers.js";

const Tester = createTester(resolve(import.meta.dirname, ".."), {
  libraries: ["@typespec/http", "@abhigyakrishna/tspgen-core", "@abhigyakrishna/tspgen-go"],
}).importLibraries().using("Http");
const module = "example.com/validator/models";
const fixture = (name: string) => readFileSync(resolve(import.meta.dirname, "fixtures", name), "utf8");

describe("Go validator struct tags", () => {
  it("keeps validator tags opt-in", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", { module }).compile(fixture("validator.tsp"));
    expect(outputs["models/models.go"]).not.toContain('validate:"');
    expect(outputs["models/models.go"]).toContain("Validate() error");
    expect(outputs["models/go.mod"]).not.toContain("go-playground");
  });

  it.each(["pointers", "values"])("validates generated structs with optional-fields=%s", async (optionalFields) => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, "optional-fields": optionalFields, "scalar-style": "alias", features: { validator: true },
    }).compile(fixture("validator.tsp"));
    expect(outputs["models/models.go"]).toContain('validate:"min=2,max=4"');
    const tests = fixture("validator_test.go");
    runGo({
      ...outputs,
      "checks/go.mod": `module example.com/validator/checks\ngo 1.27\nrequire github.com/go-playground/validator/v10 v10.30.1\n`,
    }, {
      "checks/validator_test.go": tests,
      "checks/go.sum": readFileSync(resolve(import.meta.dirname, "../../../e2e/go/go.sum"), "utf8"),
    });
  }, 180000);

  it("supports validator metadata independently of generated Validate methods", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, features: { validator: false, validation: false },
    }).compile(`using TspGen; @service namespace S;
      @meta("go", #{ features: #{ validator: true } }) model Checked { @minLength(2) name: string; }
      model Plain { checked: Checked; }
      @get op read(): Plain;
    `);
    expect(outputs["models/models.go"]).toContain('validate:"min=2"');
    expect(outputs["models/models.go"]).not.toContain("Validate() error");
  });
});
