import { resolvePath } from "@typespec/compiler";
import { createTester } from "@typespec/compiler/testing";
import { resolve } from "node:path";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const Tester = createTester(resolvePath(import.meta.dirname, ".."), {
  libraries: ["@typespec/http", "@abhigyakrishna/tspgen-core", "@abhigyakrishna/tspgen-go"],
}).importLibraries().using("Http");
const client = resolve(import.meta.dirname, "../../go-nethttp-client/dist/index.js");
const server = resolve(import.meta.dirname, "../../go-nethttp-server/dist/index.js");
const gin = resolve(import.meta.dirname, "../../go-gin-server/dist/index.js");
const module = "example.com/config/models";
const configuredSpec = readFileSync(join(import.meta.dirname, "fixtures/config.tsp"), "utf8");

function runGo(outputs: Record<string, string>, tests: Record<string, string>): void {
  const dir = mkdtempSync(join(tmpdir(), "tspgen-go-options-"));
  try {
    for (const [path, content] of Object.entries({ ...outputs, ...tests })) {
      const file = join(dir, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    const modules = Object.keys(outputs).filter((path) => path.endsWith("/go.mod")).map(dirname);
    writeFileSync(join(dir, "go.work"), `go 1.27\n\nuse (\n${modules.map((path) => `./${path}`).join("\n")}\n)\n`);
    for (const path of modules) {
      try {
        execFileSync("go", ["test", "./..."], { cwd: join(dir, path), env: { ...process.env, GOWORK: join(dir, "go.work"), GOTOOLCHAIN: "local" }, encoding: "utf8", stdio: "pipe", timeout: 150000 });
      } catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string };
        throw new Error(`${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`, { cause: error });
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const spec = `
  @service namespace Config;
  scalar TraceId extends string;
  enum State { active, inactive }
  model Pet { id: int64; created: utcDateTime; price?: decimal; trace?: TraceId; state?: State; }
  @get @route("/pets/{id}") op read(@path id: int64): Pet;
`;

describe("Go configuration", () => {
  it("only uses explicitly configured type names, including names shared with Object.prototype", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", { module }).compile(`
      @service namespace S; model constructor { id: int32 } model toString { id: int32 }
      @get op read(): constructor; @get @route("/other") op other(): toString;
    `);
    expect(outputs["models/models.go"]).toContain("type Constructor struct");
    expect(outputs["models/models.go"]).toContain("type ToString struct");
    runGo(outputs, {});
  });
  it("configures naming, layout, scalar aliases and wire type mappings", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, "go-version": "1.27", layout: "per-type", "date-time": "time.Time", decimal: "string",
      "scalar-style": "alias", naming: { initialisms: ["ID"], "enum-members": "UPPER_SNAKE" },
      "type-names": { "Config.Pet": "Animal" },
    }).compile(spec);
    expect(outputs["models/go.mod"]).toContain("go 1.27");
    expect(outputs["models/animal.go"]).toContain("type Animal struct");
    expect(outputs["models/animal.go"]).toMatch(/ID\s+int64/);
    expect(outputs["models/animal.go"]).toContain("time.Time");
    expect(outputs["models/animal.go"]).toMatch(/Price\s+\*string/);
    expect(outputs["models/trace_id.go"]).toContain("type TraceID = string");
    expect(outputs["models/state.go"]).toContain("StateACTIVE");
  });

  it("generates opt-in generic client methods only with a compatible Go version", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, "go-version": "1.27",
      targets: [{ [client]: { module: "example.com/config/client", features: { "generic-methods": true } } }],
    }).compile(spec);
    expect(outputs["client/client.go"]).toContain("func (c *Client) Do[T any]");
    expect(outputs["client/client.go"]).toContain("c.Do[*models.Pet]");
    expect(outputs["client/go.mod"]).toContain("go 1.27");
  });

  it("allows overriding client method templates with the pipeline context", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tspgen-go-templates-"));
    try {
      mkdirSync(join(dir, "nethttp-client"));
      const method = readFileSync(join(import.meta.dirname, "../../go-nethttp-client/templates/nethttp-client/method.eta"), "utf8");
      writeFileSync(join(dir, "nethttp-client/method.eta"), `// Custom <%= it.ctx.language %> method: <%= it.op.name %>\n${method}`);
      const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
        module, "template-dir": dir,
        targets: [{ [client]: { module: "example.com/config/client" } }],
      }).compile(spec);
      expect(outputs["client/client.go"]).toContain("// Custom go method: ConfigRead");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compiles grouped Gin collection body handlers with validation disabled", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module,
      targets: [{ [gin]: {
        module: "example.com/config/server", grouping: "per-namespace", features: { validate: false },
      } }],
    }).compile(`@service namespace S; @post op write(@body value: int32[]): void;`);
    const operations = outputs["server/s_operations.go"];
    expect(operations).not.toContain('"net/http"');
    expect(operations).not.toContain(`models "${module}"`);
    runGo(outputs, {});
  }, 180000);

  it("rejects generic methods below Go 1.27 without writing partial output", async () => {
    const [{ outputs }, diagnostics] = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, "go-version": "1.26",
      targets: [{ [client]: { module: "example.com/config/client", features: { "generic-methods": true } } }],
    }).compileAndDiagnose(spec);
    expect(diagnostics.map((d) => d.message)).toEqual(expect.arrayContaining([expect.stringContaining("Go 1.27")]));
    expect(outputs["client/client.go"]).toBeUndefined();
  });

  it.each([
    { modelsVersion: "1.27", targetVersion: undefined, generic: false, expected: "1.27" },
    { modelsVersion: "1.22", targetVersion: "1.27", generic: true, expected: "1.27" },
  ])("uses the effective target Go version %j", async ({ modelsVersion, targetVersion, generic, expected }) => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, "go-version": modelsVersion,
      targets: [{ [client]: { module: "example.com/config/client", ...(targetVersion ? { "go-version": targetVersion } : {}), features: { "generic-methods": generic } } }],
    }).compile(spec);
    expect(outputs["client/go.mod"]).toContain(`go ${expected}`);
    expect(outputs["client/client.go"].includes("Do[T any]")).toBe(generic);
  });

  it.each([client, server, gin])("rejects explicit target versions below the models/runtime minimum for %s", async (target) => {
    const [{ outputs }, diagnostics] = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, "go-version": "1.27", targets: [{ [target]: { module: "example.com/config/http", "go-version": "1.26" } }],
    }).compileAndDiagnose(spec);
    expect(diagnostics.map((d) => d.message)).toEqual(expect.arrayContaining([expect.stringContaining("at least Go 1.27")]));
    expect(Object.keys(outputs).some((path) => path.startsWith(target === client ? "client/" : "server/"))).toBe(false);
  });

  it("honors disabled model features, value fields, alternative numbers and specialized generic models", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, layout: "per-type", integer: "int64", decimal: "float64", "optional-fields": "values",
      features: { "go-mod": false, validation: false, defaults: false, "omit-empty": false, generics: false, header: false, docs: false },
    }).compile(`@service namespace S; model Box<T> { value: T } model Pet { count?: integer; amount?: decimal = 1.5 } @get op read(): Box<Pet>;`);
    const source = Object.values(outputs).join("\n");
    expect(outputs["models/go.mod"]).toBeUndefined();
    expect(source).not.toContain("func NewPet");
    expect(source).not.toContain("func (value *Pet) Validate");
    expect(source).not.toContain("Code generated");
    expect(source).not.toContain('default:"');
    expect(source).not.toContain(",omitempty");
    expect(source).not.toContain("[T any]");
    expect(source).toMatch(/Count\s+int64/);
    expect(source).toMatch(/Amount\s+float64/);
    runGo({ ...outputs, "models/go.mod": `module ${module}\ngo 1.22\n` }, {});
  });

  it("supports per-model metadata overrides for defaults and validation", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", { module }).compile(`
      using TspGen;
      @service namespace S;
      @meta("go", #{ features: #{ validation: false, defaults: false } }) model Plain { @minLength(2) name?: string = "ok" }
      model Checked { @minValue(1) id: int64; }
      @get op read(): Plain;
      @get @route("/checked") op checked(): Checked;
    `);
    expect(outputs["models/models.go"]).not.toContain("func NewPlain");
    expect(outputs["models/models.go"]).not.toContain("func (value *Plain) Validate");
    expect(outputs["models/models.go"]).toContain("func NewChecked");
    expect(outputs["models/models.go"]).toContain("func (value *Checked) Validate");
    runGo(outputs, {});
  });

  it("can enable model validation and defaults through metadata when the global gates are off", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, features: { validation: false, defaults: false }, targets: [{ [server]: { module: "example.com/config/server" } }],
    }).compile(`using TspGen; @service namespace S;
      @meta("go", #{ features: #{ validation: true, defaults: true } }) model Enabled { @minLength(2) name: string = "ok" }
      @post op create(@body value: Enabled): Enabled;
    `);
    expect(outputs["models/models.go"]).toContain("func NewEnabled");
    expect(outputs["models/models.go"]).toContain("func (value *Enabled) Validate");
    expect(outputs["server/server.go"]).toContain("models.DecodeJSON(body, target, false, true, true, shape)");
    runGo(outputs, {});
  });

  it.each([server, gin])("runs relaxed JSON policies and namespace grouping for %s", async (target) => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, targets: [
        { [client]: { module: "example.com/config/client", grouping: "per-namespace", features: { "encode-defaults": true, "explicit-nulls": false } } },
        { [target]: { module: "example.com/config/server", grouping: "per-namespace", "error-body": "none", features: { validate: false, "ignore-unknown-keys": true, "encode-defaults": true, "explicit-nulls": false } } },
      ],
    }).compile(`@service namespace S; model Value { id: int32; count?: int32 = 4; note: string | null; }
      @post @route("/echo") op echo(@body value: Value): Value;
      @get @route("/fail") op fail(): Value;
    `);
    const code = Object.entries(outputs).filter(([path]) => path.startsWith("client/")).map(([, value]) => value).join("\n");
    expect(code).toContain("models.EncodeJSON(request.Body, true, false)");
    runGo(outputs, { "server/policy_test.go": `package server_test
      import ("context"; "errors"; "net/http/httptest"; "strings"; "testing"; models "${module}"; server "example.com/config/server")
      type service struct{}
      func (service) SEcho(_ context.Context, r server.SEchoRequest) (*models.Value, error) { return r.Body, nil }
      func (service) SFail(_ context.Context, _ server.SFailRequest) (*models.Value, error) { return nil, errors.New("secret") }
      func TestPolicies(t *testing.T) {
        router := server.NewHandler(service{})
        request := httptest.NewRequest("POST", "/echo", strings.NewReader("{\\"extra\\":1}")); request.Header.Set("Content-Type", "application/json")
        result := httptest.NewRecorder(); router.ServeHTTP(result, request)
        if result.Code != 200 || strings.Contains(result.Body.String(), "note") || !strings.Contains(result.Body.String(), "\\"count\\":4") { t.Fatalf("relaxed: %d %s", result.Code, result.Body.String()) }
        result = httptest.NewRecorder(); router.ServeHTTP(result, httptest.NewRequest("GET", "/fail", nil))
        if result.Code != 500 || result.Body.Len() != 0 { t.Fatalf("empty fallback: %d %s", result.Code, result.Body.String()) }
      }
    ` });
  });

  it.each([client, server, gin])("supports independently disabling module and constructor output for %s", async (target) => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, targets: [{ [target]: { module: "example.com/config/http", features: { "go-mod": false, ...(target === client ? { "client-constructor": false } : { handler: false }) } } }],
    }).compile(spec);
    const kind = target === client ? "client" : "server";
    expect(outputs[`${kind}/go.mod`]).toBeUndefined();
    expect(outputs[`${kind}/${kind}.go`]).not.toContain(target === client ? "func NewClient" : "func NewHandler");
    if (target !== client) expect(outputs["server/server.go"]).toContain("func RegisterRoutes");
  });

  it.each([
    [{ "type-names": { "Config.Pet": "ValidationError" } }, {}, "ValidationError"],
    [{ "type-names": { "Config.Pet": "PropertyConstraints" } }, {}, "PropertyConstraints"],
    [{ naming: { "operation-prefix": "none" } }, { "client-name": "ReadRequest" }, "ReadRequest"],
  ])("diagnoses generated identifier collisions %j", async (emitterOptions, targetOptions, name) => {
    const [, diagnostics] = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, ...emitterOptions, targets: [{ [client]: { module: "example.com/config/client", ...targetOptions } }],
    }).compileAndDiagnose(spec);
    expect(diagnostics.map((d) => d.message)).toEqual(expect.arrayContaining([expect.stringContaining(name)]));
  });

  it.each([server, gin])("configures server handler contracts and JSON policy for %s", async (target) => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, targets: [{ [target]: {
        module: "example.com/config/server", "service-name": "API", "handler-shape": "params",
        "error-body": "problem", "max-body-size": 128,
        features: { "call-access": true, handler: false, "ignore-unknown-keys": false },
      } }],
    }).compile(spec);
    expect(outputs["server/server.go"]).toContain("type API interface");
    expect(outputs["server/server.go"]).not.toContain("func NewHandler(");
    expect(outputs["server/server.go"]).toContain("application/problem+json");
    expect(outputs["server/server.go"]).toContain("128");
  });

  it.each([server, gin])("runs configured models, generic client methods and grouped server contracts for %s", async (target) => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, "go-version": "1.27", layout: "per-namespace", "date-time": "time.Time", decimal: "string",
      "scalar-style": "alias", naming: { initialisms: ["ID"] }, "type-names": { "Config.Pet": "Animal" },
      features: { "enum-unknown": true },
      targets: [
        { [client]: { module: "example.com/config/client", grouping: "per-interface", "client-name": "Gateway", "request-suffix": "Input", errors: "typed", "timeout-ms": 100, "max-response-size": 512, features: { "generic-methods": true, validate: true, "ignore-unknown-keys": false } } },
        { [target]: { module: "example.com/config/server", grouping: "per-interface", "service-name": "API", "handler-shape": "params", "request-suffix": "Input", errors: "typed", "max-body-size": 512, "error-body": "problem", features: { handler: false, "call-access": true } } },
      ],
    }).compile(configuredSpec);
    expect(outputs["models/config.go"]).toContain("type Page[T any]");
    expect(outputs["server/server.go"]).not.toContain("func NewHandler(");
    const isGin = target === gin;
    const fixture = readFileSync(join(import.meta.dirname, "fixtures/http_test.go"), "utf8")
      .replaceAll("CALL_TYPE", isGin ? "gin.Context" : "http.Request")
      .replace("// GIN_IMPORT", isGin ? '"github.com/gin-gonic/gin"' : "")
      .replaceAll("// ROUTER", isGin ? "router := gin.New(); router.UseEscapedPath = true" : "router := http.NewServeMux()")
      .replace("CALL_CHECK", isGin ? 'call.Request.Header.Get("x-test")' : 'call.Header.Get("x-test")');
    runGo(outputs, {
      "models/models_test.go": readFileSync(join(import.meta.dirname, "fixtures/models_test.go"), "utf8"),
      "server/server_test.go": fixture,
    });
  });
});
