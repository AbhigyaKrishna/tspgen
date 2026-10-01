import { resolvePath } from "@typespec/compiler";
import { createTester } from "@typespec/compiler/testing";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const Tester = createTester(resolvePath(import.meta.dirname, ".."), {
  libraries: ["@typespec/http", "@abhigyakrishna/tspgen-core", "@abhigyakrishna/tspgen-go"],
}).importLibraries().using("Http");

const target = resolve(import.meta.dirname, "../dist/index.js");
const clientTarget = resolve(import.meta.dirname, "../../go-nethttp-client/dist/index.js");
const options = {
  module: "example.com/pets/models/v2",
  targets: [{ [target]: { module: "example.com/pets/server", "max-body-size": 256 } }],
};
const spec = readFileSync(join(import.meta.dirname, "fixtures/main.tsp"), "utf8");

function runGo(outputs: Record<string, string>, fixture?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tspgen-gin-"));
  try {
    for (const [path, content] of Object.entries(outputs)) {
      const file = join(dir, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    if (fixture) writeFileSync(join(dir, "server/server_test.go"), readFileSync(join(import.meta.dirname, "fixtures", fixture)));
    const modules = Object.keys(outputs).filter((path) => path.endsWith("/go.mod")).map((path) => `\t./${dirname(path)}`);
    writeFileSync(join(dir, "go.work"), `go 1.25.0\n\nuse (\n${modules.join("\n")}\n)\n`);
    try {
      return execFileSync("go", ["test", "-v", "./..."], {
        cwd: join(dir, "server"),
        env: { ...process.env, GOWORK: join(dir, "go.work"), GOTOOLCHAIN: "local" },
        encoding: "utf8", stdio: "pipe", timeout: 150000,
      });
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`, { cause: error });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Go Gin server", () => {
  it("emits a separate Gin module with portable service contracts", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", options).compile(spec);
    expect(outputs["server/go.mod"]).toContain("github.com/gin-gonic/gin v1.12.0");
    expect(outputs["server/go.mod"]).toContain("go 1.25.0");
    expect(outputs["server/go.mod"]).toContain("example.com/pets/models/v2 v2.0.0");
    expect(outputs["server/go.mod"]).toContain("replace example.com/pets/models/v2 => ../models");
    expect(outputs["server/server.go"]).toContain("func RegisterRoutes(router gin.IRoutes, service Service)");
    expect(outputs["server/server.go"]).toContain("func NewHandler(service Service) *gin.Engine");
    expect(outputs["server/server.go"]).toContain("router.Handle(\"GET\", escapedRoute(\"/pets/:p2/details\")");
    expect(outputs["server/server.go"]).toMatch(/PetsRead\(ctx context.Context, request PetsReadRequest\)/);
    expect(execFileSync("gofmt", { input: outputs["server/server.go"], encoding: "utf8" })).toBe(outputs["server/server.go"]);
  });

  it("rejects routes that Gin cannot represent", async () => {
    const [{ outputs }, diagnostics] = await Tester.emit("@abhigyakrishna/tspgen-go", options).compileAndDiagnose(`
      @service namespace S;
      model Result { ok: boolean; }
      @get @route("/files/{name}.json") op read(@path name: string): Result;
    `);
    expect(diagnostics.map((d) => d.code)).toContain("@abhigyakrishna/tspgen-go/unsupported-operation");
    expect(diagnostics.map((d) => d.message)).toEqual(expect.arrayContaining([expect.stringContaining("whole segment")]));
    expect(outputs["server/server.go"]).toBeUndefined();
  });

  it.each([
    { module: "example.com/pets/server", "max-body-size": 0 },
    { module: "example.com/pets/server", "max-body-size": 1.5 },
    { module: "example.com/pets/server", "max-body-size": 2147483648 },
    {},
  ])("validates target options %j", async (targetOptions) => {
    const [, diagnostics] = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module: options.module, targets: [{ [target]: targetOptions }],
    }).compileAndDiagnose(spec);
    expect(diagnostics.map((d) => d.code)).toContain("@abhigyakrishna/tspgen-core/invalid-target-options");
  });

  it.each([
    [{ module: "bad module" }, "invalid-module"],
    [{ module: "example.com/pets/server", package: "func" }, "invalid-package"],
    [{ module: options.module }, "target-failed"],
  ])("rejects invalid module/package configuration %j", async (targetOptions, code) => {
    const [{ outputs }, diagnostics] = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module: options.module, targets: [{ [target]: targetOptions }],
    }).compileAndDiagnose(spec);
    expect(diagnostics.some((d) => d.code.endsWith(`/${code}`))).toBe(true);
    expect(outputs["server/server.go"]).toBeUndefined();
  });

  it("resolves the models module when output directories differ", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module: options.module,
      "models-output-dir": "{emitter-output-dir}/shared",
      targets: [{ [target]: { module: "example.com/pets/server", package: "handlers", "output-dir": "{emitter-output-dir}/http" } }],
    }).compile(spec);
    expect(outputs["http/server/go.mod"]).toContain("replace example.com/pets/models/v2 => ../../shared/models");
    expect(outputs["http/server/server.go"]).toContain("package handlers");
    expect(outputs["shared/models/models.go"]).toContain("package models");
  });

  it("compiles an empty service without unused imports", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", options).compile("@service namespace Empty;");
    expect(runGo(outputs)).toContain("[no test files]");
  }, 180000);

  it("compiles and exercises generated routes with Gin and the net/http client", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
      ...options,
      targets: [...options.targets, { [clientTarget]: { module: "example.com/pets/client" } }],
    }).compile(spec);
    expect(runGo(outputs, "server_test.go")).toContain("PASS");
  }, 180000);
});
