import { resolvePath } from "@typespec/compiler";
import { createTester } from "@typespec/compiler/testing";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const Tester = createTester(resolvePath(import.meta.dirname, ".."), {
  libraries: ["@typespec/http", "@abhigyakrishna/tspgen-core", "@abhigyakrishna/tspgen-go"],
}).importLibraries().using("Http");

const clientTarget = resolve(import.meta.dirname, "../../go-nethttp-client/dist/index.js");
const serverTarget = resolve(import.meta.dirname, "../../go-nethttp-server/dist/index.js");
const modules = {
  models: "example.com/pets/models/v2",
  client: "example.com/pets/client",
  server: "example.com/pets/server",
};

const spec = `
@service namespace Pets;
model Pet { id: int64; name?: string; price?: decimal; }
@route("/pets") interface Pets {
  @get read(@path id: int64): Pet;
  @post create(@body pet: Pet): { @statusCode _: 201; @body pet: Pet };
  @get @route("/names/{name}") lookup(@path name: string, @query active?: boolean, @header("x-trace") trace?: string): Pet;
}
`;

describe("Go standard-library targets", () => {
  it("reports unsupported model and operation shapes", async () => {
    const [, diagnostics] = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module: modules.models,
      targets: [{ [clientTarget]: { module: modules.client } }],
    }).compileAndDiagnose(`
      @service namespace S;
      model Pet { id: int32 }
      union Choice { pet: Pet, text: string }
      model Box { choice: Choice }
      @route("/things") op read(): Pet | { @statusCode _: 201; @body pet: Pet };
    `);
    const codes = diagnostics.map((d) => d.code);
    expect(codes).toContain("@abhigyakrishna/tspgen-go/unsupported-type");
    expect(codes).toContain("@abhigyakrishna/tspgen-go/unsupported-operation");
  });

  it("emits separate modules whose client and server interoperate", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module: modules.models,
      targets: [
        { [clientTarget]: { module: modules.client } },
        { [serverTarget]: { module: modules.server } },
      ],
    }).compile(spec);
    expect(outputs["models/models.go"]).toContain("type Pet struct {");
    expect(outputs["models/models.go"]).toMatch(/Name\s+\*string\s+`json:"name,omitempty" tsp:"optional,_"`/);
    expect(outputs["client/go.mod"]).toContain(`module ${modules.client}`);
    expect(outputs["client/go.mod"]).toContain(`require ${modules.models} v2.0.0`);
    expect(outputs["server/go.mod"]).toContain(`module ${modules.server}`);
    for (const file of ["models/models.go", "client/client.go", "server/server.go"]) {
      expect(execFileSync("gofmt", { input: outputs[file], encoding: "utf8" })).toBe(outputs[file]);
    }

    const dir = mkdtempSync(join(tmpdir(), "tspgen-go-"));
    for (const [path, content] of Object.entries(outputs)) {
      const file = join(dir, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    writeFileSync(join(dir, "go.work"), "go 1.22\n\nuse (\n\t./models\n\t./client\n\t./server\n)\n");
    writeFileSync(join(dir, "client", "client_test.go"), `package client_test

import (
  "context"
  "net/http/httptest"
  "testing"

  client "${modules.client}"
  models "${modules.models}"
  server "${modules.server}"
)

type service struct{}

func (service) PetsRead(_ context.Context, request server.PetsReadRequest) (*models.Pet, error) {
  if request.PathId == 0 { return nil, &server.HTTPError{StatusCode: 404, Body: map[string]string{"message": "not found"}} }
  return &models.Pet{Id: request.PathId}, nil
}

func (service) PetsCreate(_ context.Context, request server.PetsCreateRequest) (*models.Pet, error) {
  return request.Body, nil
}

func (service) PetsLookup(_ context.Context, request server.PetsLookupRequest) (*models.Pet, error) {
  if request.PathName != "a/b" || request.QueryActive == nil || !*request.QueryActive || request.HeaderTrace == nil || *request.HeaderTrace != "ok" {
    return nil, &server.HTTPError{StatusCode: 400}
  }
  return &models.Pet{Id: 7, Name: &request.PathName}, nil
}

func TestRoundTrip(t *testing.T) {
  httpServer := httptest.NewServer(server.NewHandler(service{}))
  defer httpServer.Close()
  api := &client.Client{BaseURL: httpServer.URL}
  pet, err := api.PetsRead(context.Background(), client.PetsReadRequest{PathId: 42})
  if err != nil || pet.Id != 42 { t.Fatalf("read: pet=%+v err=%v", pet, err) }
  created, err := api.PetsCreate(context.Background(), client.PetsCreateRequest{Body: &models.Pet{Id: 9}})
  if err != nil || created.Id != 9 { t.Fatalf("create: pet=%+v err=%v", created, err) }
  active, trace := true, "ok"
  found, err := api.PetsLookup(context.Background(), client.PetsLookupRequest{PathName: "a/b", QueryActive: &active, HeaderTrace: &trace})
  if err != nil || found.Id != 7 { t.Fatalf("lookup: pet=%+v err=%v", found, err) }
  _, err = api.PetsRead(context.Background(), client.PetsReadRequest{PathId: 0})
  if httpErr, ok := err.(*client.HTTPError); !ok || httpErr.StatusCode != 404 { t.Fatalf("error: %v", err) }
}
`);
    expect(() => execFileSync("go", ["test", "./..."], {
      cwd: join(dir, "client"),
      env: { ...process.env, GOWORK: join(dir, "go.work"), GOTOOLCHAIN: "local" },
      encoding: "utf8",
      stdio: "pipe",
    })).not.toThrow();
  });
});
