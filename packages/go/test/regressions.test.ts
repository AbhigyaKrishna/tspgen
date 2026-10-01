import { createTester } from "@typespec/compiler/testing";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runGo } from "./helpers.js";

const Tester = createTester(resolve(import.meta.dirname, ".."), {
  libraries: ["@typespec/http", "@abhigyakrishna/tspgen-core", "@abhigyakrishna/tspgen-go"],
}).importLibraries().using("Http");
const client = resolve(import.meta.dirname, "../../go-nethttp-client/dist/index.js");
const server = resolve(import.meta.dirname, "../../go-nethttp-server/dist/index.js");
const gin = resolve(import.meta.dirname, "../../go-gin-server/dist/index.js");
const module = "example.com/regressions/models";
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

describe("Go correctness regressions", () => {
  it.each([
    ["equivalent wildcards", "/things/{id}", "/things/{name}", "id", "name", "get", "get"],
    ["crossing paths", "/{entity}/latest", "/users/{id}", "entity", "id", "get", "get"],
    ["crossing GET and HEAD specificity", "/users/{id}", "/{entity}/latest", "id", "entity", "get", "head"],
  ])("diagnoses conflicting net/http routes: %s", async (_name, first, second, firstParam, secondParam, firstVerb, secondVerb) => {
    const [{ outputs }, diagnostics] = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, targets: [{ [server]: { module: "example.com/regressions/server" } }],
    }).compileAndDiagnose(`@service namespace S;
      @${firstVerb} @route("${first}") op one(@path ${firstParam}: string): void;
      @${secondVerb} @route("${second}") op two(@path ${secondParam}: string): void;
    `);
    expect(diagnostics.some((diagnostic) => diagnostic.code === "@abhigyakrishna/tspgen-go/unsupported-operation")).toBe(true);
    expect(Object.keys(outputs)).toHaveLength(0);
  });

  it("retains exact root routes, more-specific routes, and separate methods", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, targets: [{ [server]: { module: "example.com/regressions/server" } }],
    }).compile(fixture("routes-regressions.tsp"));
    runGo(outputs, { "server/routes_test.go": fixture("routes-regressions_test.go") });
  });

  it.each([false, true])("compiles enum aliases with enum-unknown=%s", async (unknown) => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, features: { "enum-unknown": unknown },
    }).compile(`@service namespace S;
      enum State { first: "active", second: "active" }
      enum Code { first: 1, second: 1 }
      model Payload { state: State; code: Code; }
      @get op read(): Payload;
    `);
    runGo(outputs, { "models/enums_test.go": fixture("enums-regressions_test.go") });
  });

  it("preserves generic nullability and integer semantics when decoding and validating", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", { module }).compile(fixture("models-regressions.tsp"));
    runGo(outputs, { "models/models_test.go": fixture("models-regressions_test.go") });
  });

  it("dispatches fixed error statuses before ranges and defaults", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, targets: [{ [client]: { module: "example.com/regressions/client", errors: "typed" } }],
    }).compile(fixture("errors-regressions.tsp"));
    runGo(outputs, { "client/errors_test.go": fixture("errors-regressions_test.go") });
  });

  it.each([server, gin])("validates generic bodies across client and server boundaries for %s", async (target) => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, targets: [
        { [client]: { module: "example.com/regressions/client", features: { validate: true } } },
        { [target]: { module: "example.com/regressions/server" } },
      ],
    }).compile(fixture("http-generics-regressions.tsp"));
    runGo(outputs, { "server/generics_test.go": fixture("http-generics-regressions_test.go") });
  }, 180000);
});
