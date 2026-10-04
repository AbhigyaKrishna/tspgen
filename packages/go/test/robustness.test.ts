import { createTester } from "@typespec/compiler/testing";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { goName, sourceFileName, validJSONTagName } from "../src/naming.js";
import { runGo } from "./helpers.js";

const Tester = createTester(resolve(import.meta.dirname, ".."), {
  libraries: ["@typespec/http", "@abhigyakrishna/tspgen-core", "@abhigyakrishna/tspgen-go"],
}).importLibraries().using("Http");
const client = resolve(import.meta.dirname, "../../go-nethttp-client/dist/index.js");
const server = resolve(import.meta.dirname, "../../go-nethttp-server/dist/index.js");
const module = "example.com/review/models";
const clientModule = { module: "example.com/review/client" };
const serverModule = { module: "example.com/review/server" };

describe("Go generation robustness", () => {
  it("compiles client operations that use no models", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, targets: [
        { [client]: { ...clientModule, grouping: "per-interface" } },
        { [server]: { ...serverModule, grouping: "per-interface" } },
      ],
    }).compile(`@service namespace S;
      @route("/ping") interface Health { @delete ping(): void; }
    `);
    runGo(outputs, {});
  }, 180000);

  it("keeps model files out of test and platform-constrained builds", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", { module, layout: "per-type" }).compile(`
      @service namespace S;
      model PetTest { id: int32 }
      model CatWindows { id: int32 }
      model DogArm64 { id: int32 }
      @get op read(): PetTest;
    `);
    const files = Object.keys(outputs).filter((path) => path.endsWith(".go"));
    expect(files).toContain("models/pet_test_types.go");
    expect(files).toContain("models/cat_windows_types.go");
    expect(files).toContain("models/dog_arm64_types.go");
  });

  it("rejects JSON names encoding/json cannot use as struct tag names", async () => {
    const [, diagnostics] = await Tester.emit("@abhigyakrishna/tspgen-go", { module }).compileAndDiagnose(`
      @service namespace S;
      model Pet { @encodedName("application/json", "say \\"hi\\"") greeting: string }
      @get op read(): Pet;
    `);
    expect(diagnostics.map((d) => d.code)).toContain("@abhigyakrishna/tspgen-go/unsupported-type");
  });

  it("defaults typed range errors to a status inside their range", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, targets: [{ [server]: { ...serverModule, errors: "typed" } }],
    }).compile(`@service namespace S;
      @error model Broad { @statusCode @minValue(400) @maxValue(499) status: int32; message: string; }
      @get @route("/r") op read(): void | Broad;
    `);
    expect(outputs["server/server.go"]).toMatch(/func \(e \*SRead400To499Error\) HTTPStatus\(\) int \{[^}]*\}\n\treturn 400\n\}/);
  });

  it("answers bodiless service errors with the fallback error body instead of null", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, targets: [{ [server]: { ...serverModule, errors: "typed" } }],
    }).compile(`@service namespace S;
      @error model Missing { @statusCode _: 404 }
      model Pet { id: string }
      @get @route("/pets/{id}") op read(@path id: string): void | Missing;
    `);
    runGo(outputs, { "server/errors_test.go": `package server_test

import (
	"context"
	"net/http/httptest"
	"testing"

	"example.com/review/models"
	server "example.com/review/server"
)

type service struct{ err error }

func (s service) SRead(context.Context, server.SReadRequest) error { return s.err }

func TestBodilessErrors(t *testing.T) {
	for name, err := range map[string]error{
		"typed":     &server.SRead404Error{},
		"nil body":  &server.HTTPError{StatusCode: 404},
		"typed nil": &server.HTTPError{StatusCode: 404, Body: (*models.Pet)(nil)},
	} {
		recorder := httptest.NewRecorder()
		server.NewHandler(service{err}).ServeHTTP(recorder, httptest.NewRequest("GET", "/pets/1", nil))
		if recorder.Code != 404 || recorder.Body.String() != \`{"error":"Not Found"}\` {
			t.Errorf("%s: got %d %q", name, recorder.Code, recorder.Body.String())
		}
	}
}
` });
  }, 180000);

  it("names exported identifiers, source files and JSON tags safely", () => {
    expect(goName("_")).toBe("X_");
    expect(goName("2fa")).toBe("X2fa");
    expect(sourceFileName("PetTest")).toBe("pet_test_types");
    expect(sourceFileName("LinuxAmd64")).toBe("linux_amd64_types");
    expect(sourceFileName("Windows")).toBe("windows");
    expect(sourceFileName("Runtime", ["runtime"])).toBe("runtime_types");
    expect(validJSONTagName("x-trace.id")).toBe(true);
    expect(validJSONTagName("名前")).toBe(true);
    for (const name of ["", "a,b", 'a"b', "a\\b", "it's"]) expect(validJSONTagName(name)).toBe(false);
  });
});
