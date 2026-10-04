import { createTester } from "@typespec/compiler/testing";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runGo } from "./helpers.js";

const Tester = createTester(resolve(import.meta.dirname, ".."), {
  libraries: ["@typespec/http", "@abhigyakrishna/tspgen-core", "@abhigyakrishna/tspgen-go"],
}).importLibraries().using("Http");
const module = "example.com/params/models";
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const client = resolve(import.meta.dirname, "../../go-nethttp-client/dist/index.js");
const server = resolve(import.meta.dirname, "../../go-nethttp-server/dist/index.js");
const gin = resolve(import.meta.dirname, "../../go-gin-server/dist/index.js");

describe("Go union parameters", () => {
  it("resolves union text by specificity", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", { module }).compile(fixture("union-params.tsp"));
    expect(outputs["models/models.go"]).toContain("func (value *Mode) UnmarshalText(data []byte) error");
    runGo(outputs, { "models/union_text_test.go": fixture("union-text_test.go") });
  }, 180000);

  it.each([server, gin])("sends enum and union query, header and path parameters to %s", async (target) => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, targets: [
        { [client]: { module: "example.com/params/client" } },
        { [target]: { module: "example.com/params/server" } },
      ],
    }).compile(fixture("union-params.tsp"));
    const isGin = target === gin;
    runGo(outputs, { "server/union_params_test.go": fixture("union-params-http_test.go")
      .replace("// GIN_IMPORT", isGin ? '"github.com/gin-gonic/gin"' : "")
      .replace("// ROUTER", isGin ? "router := gin.New(); router.UseEscapedPath = true" : "router := http.NewServeMux()") });
  }, 180000);

  it("compiles numeric enum parameters and fields with layout per-type", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, layout: "per-type", targets: [
        { [client]: { module: "example.com/params/client" } },
        { [server]: { module: "example.com/params/server" } },
      ],
    }).compile(fixture("union-params.tsp"));
    expect(outputs["models/level.go"]).toContain("func (value *Level) decodeParameter(raw string) error");
    expect(outputs["models/picked.go"]).toContain("Level Level");
    runGo(outputs, {});
  }, 180000);

  it("maps unknown enum parameters with enum-unknown", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, decimal: "string", features: { "enum-unknown": true },
    }).compile(fixture("union-params.tsp"));
    runGo(outputs, { "models/union_unknown_test.go": fixture("union-params-unknown_test.go") });
  }, 180000);

  it("rejects union parameters with non-text variants", async () => {
    const [, diagnostics] = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, targets: [{ [client]: { module: "example.com/params/client" } }],
    }).compileAndDiagnose(`
      @service namespace S;
      model Pet { name: string; }
      union Bad { pet: Pet, count: int32 }
      @discriminated union Tagged { a: Pet }
      union Nullable { a: int32, b: string | null }
      union Binary { a: int32, b: bytes }
      @get @route("/a") op one(@query bad: Bad): void;
      @get @route("/b") op two(@query pet: Pet): void;
      @get @route("/c") op three(@query tagged: Tagged): void;
      @get @route("/d") op four(@query nullable: Nullable): void;
      @get @route("/e") op five(@header binary: Binary): void;
    `);
    const found = diagnostics.filter((d) => d.code === "@abhigyakrishna/tspgen-go/unsupported-operation");
    expect(found).toHaveLength(5);
    expect(found.every((d) => d.message.includes("scalars, enums, or unions of scalar, literal, or enum variants"))).toBe(true);
  });
});
