import { createTester } from "@typespec/compiler/testing";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runGo } from "./helpers.js";

const Tester = createTester(resolve(import.meta.dirname, ".."), {
  libraries: ["@typespec/http", "@abhigyakrishna/tspgen-core", "@abhigyakrishna/tspgen-go"],
}).importLibraries().using("Http");
const module = "example.com/additional/models";
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

describe("Go additional properties", () => {
  it("declares an AdditionalProperties map and object codecs", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", { module }).compile(fixture("additional.tsp"));
    const models = outputs["models/models.go"];
    expect(models).toContain('AdditionalProperties map[string]int32 `json:"-" tsp:"additional,m_"`');
    expect(models).toContain('AdditionalProperties map[string]*Inner `json:"-" tsp:"additional,m_"`');
    expect(models).toContain('AdditionalProperties map[string]any `json:"-" tsp:"additional,m?_"`');
    expect(models).toMatch(/type Child struct \{[^}]*AdditionalProperties map\[string\]string/);
    expect(models).toContain("return marshalObject(plain(value), nil, value.AdditionalProperties)");
    expect(models).toContain("return unmarshalObject(data, (*plain)(value), unionTagsCat, &value.AdditionalProperties)");
    runGo(outputs, {});
  }, 180000);

  it("diagnoses fields named AdditionalProperties", async () => {
    const [, diagnostics] = await Tester.emit("@abhigyakrishna/tspgen-go", { module }).compileAndDiagnose(`
      @service namespace S;
      model Box { additionalProperties: string; ...Record<string>; }
      @get op read(): Box;
    `);
    const found = diagnostics.filter((d) => d.code === "@abhigyakrishna/tspgen-go/duplicate-name");
    expect(found.some((d) => d.message.includes("AdditionalProperties"))).toBe(true);
  });

  it("inherits std Record bases without declaring them", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", { module }).compile(`
      @service namespace S;
      model Settings extends Record<string> { name: string; }
      model Bag<T> extends Record<T> {}
      model Holder { settings: Settings; bag: Bag<int32>; }
      @get op read(): Holder;
    `);
    const models = outputs["models/models.go"];
    expect(models).not.toMatch(/\bRecord\w*\b/);
    expect(models).toMatch(/type Settings struct \{[^}]*AdditionalProperties map\[string\]string/);
    expect(models).toMatch(/type BagInt32 struct \{[^}]*AdditionalProperties map\[string\]int32/);
    runGo(outputs, {});
  }, 180000);

  it("applies JSON policies to additional properties", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", { module }).compile(fixture("additional.tsp"));
    runGo(outputs, { "models/additional_test.go": fixture("additional_test.go") });
  }, 180000);
});
