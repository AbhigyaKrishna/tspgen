import { createTester } from "@typespec/compiler/testing";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApiIR } from "@abhigyakrishna/tspgen-core";
import { goType } from "../src/transform/type-map.js";
import { runGo } from "./helpers.js";

const Tester = createTester(resolve(import.meta.dirname, ".."), {
  libraries: ["@typespec/http", "@abhigyakrishna/tspgen-core", "@abhigyakrishna/tspgen-go"],
}).importLibraries().using("Http");
const module = "example.com/unions/models";
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const client = resolve(import.meta.dirname, "../../go-nethttp-client/dist/index.js");
const server = resolve(import.meta.dirname, "../../go-nethttp-server/dist/index.js");

describe("Go unions", () => {
  it("generates open enums for string literals widened by string", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", { module, features: { validator: true, "enum-unknown": true } }).compile(`
      @service namespace S;
      union Color { red: "red", blue: "blue", string }
      model Paint { color: Color; }
      @get op read(): Paint;
    `);
    const models = outputs["models/models.go"];
    expect(models).toContain("type Color string");
    expect(models).toContain('ColorRed  Color = "red"');
    expect(models).not.toContain("func (value Color) Validate() error");
    expect(models).not.toContain("eq=red");
    expect(models).not.toContain("UNKNOWN");
    runGo(outputs, {
      "models/open_enum_test.go": `package models
import "testing"
func TestOpenEnum(t *testing.T) {
	var paint *Paint
	if err := DecodeJSON([]byte(\`{"color":"green"}\`), &paint, false, true, true); err != nil || paint.Color != "green" {
		t.Fatalf("open enum rejected: %v", err)
	}
}
`,
    });
  }, 180000);

  it("declares union structs and variant codecs", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", { module }).compile(fixture("unions.tsp"));
    const models = outputs["models/models.go"];
    expect(models).toMatch(/type Pet struct \{\n\tCat \*Cat\n\tDog \*Dog\n\}/);
    expect(models).toMatch(/type Item struct \{\n\tLarge \*Large\n\tSmall \*Small\n\}/);
    expect(models).toMatch(/type HolderScalar struct \{\n\tInt32\s+\*int32\n\tString\s+\*string\n\tBoolean \*bool\n\}/);
    expect(models).toContain("func NewPetCat(value *Cat) *Pet {");
    expect(models).toMatch(/Pet\s+\*Pet\s+`json:"pet"/);
    expect(models).toContain("func (value Cat) MarshalJSON() ([]byte, error) {");
    expect(models).not.toMatch(/type Cat struct \{[^}]*Kind/);
  });

  it("round-trips unions through the generated runtime", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", { module }).compile(fixture("unions.tsp"));
    runGo(outputs, { "models/unions_test.go": fixture("unions_test.go") });
  }, 180000);

  it("diagnoses conflicting discriminator values", async () => {
    const [, diagnostics] = await Tester.emit("@abhigyakrishna/tspgen-go", { module }).compileAndDiagnose(`
      @service namespace S;
      model Cat { name: string; }
      model Dog { name: string; }
      @discriminated(#{ envelope: "none" }) union A { cat: Cat, dog: Dog }
      @discriminated(#{ envelope: "none" }) union B { kitty: Cat, dog: Dog }
      model Box { a: A; b: B; }
      @get op read(): Box;
    `);
    expect(diagnostics.map((d) => d.code)).toContain("@abhigyakrishna/tspgen-go/unsupported-type");
  });

  it("round-trips an encoded discriminator name", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", { module }).compile(`
      @service namespace S;
      @discriminator("kind")
      model Pet { @encodedName("application/json", "type") kind: string; name: string; }
      model Cat extends Pet { kind: "cat"; }
      @get op read(): Pet;
    `);
    expect(outputs["models/models.go"]).not.toMatch(/type Cat struct \{[^}]*Kind/);
    runGo(outputs, {
      "models/encoded_test.go": `package models
import (
	"encoding/json"
	"testing"
)
func TestEncodedDiscriminator(t *testing.T) {
	const raw = \`{"type":"cat","name":"Tom"}\`
	var pet Pet
	if err := json.Unmarshal([]byte(raw), &pet); err != nil || pet.Cat == nil || pet.Cat.Name != "Tom" {
		t.Fatalf("decode: %+v %v", pet, err)
	}
	if out, err := json.Marshal(pet); err != nil || string(out) != raw {
		t.Fatalf("encode: %s %v", out, err)
	}
}
`,
    });
  }, 180000);

  it("declares each generic union instance", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", { module }).compile(`
      @service namespace S;
      union Maybe<T> { T, string }
      model Box { a: Maybe<int32>; b: Maybe<boolean>; }
      @get op read(): Box;
    `);
    const models = outputs["models/models.go"];
    expect(models).toMatch(/type MaybeInt32 struct \{\n\tInt32\s+\*int32\n\tString \*string\n\}/);
    expect(models).toMatch(/type MaybeBoolean struct \{\n\tBoolean \*bool\n\tString\s+\*string\n\}/);
    expect(models).toMatch(/B \*MaybeBoolean/);
    runGo(outputs, {});
  }, 180000);

  it("compiles tagged codecs for generic variant models", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", { module }).compile(`
      @service namespace S;
      model Payload<T> { value: T; }
      @discriminated(#{ envelope: "none" }) union Event { created: Payload<int32>, deleted: Payload<string> }
      @discriminator("kind")
      model Pet { kind: string; }
      model Owned<T> extends Pet { kind: "owned"; owner: T; }
      model Home { event: Event; pet: Pet; owned: Owned<string>; }
      @get op read(): Home;
    `);
    // Core keeps tagged template instances as concrete per-instance models, so the codecs are not generic.
    const models = outputs["models/models.go"];
    expect(models).toContain("type plain PayloadInt32");
    expect(models).toContain("type plain PayloadString");
    expect(models).toContain("type plain OwnedString");
    runGo(outputs, {});
  }, 180000);

  it("rejects discriminated models nested in envelope-none unions", async () => {
    const [, diagnostics] = await Tester.emit("@abhigyakrishna/tspgen-go", { module }).compileAndDiagnose(`
      @service namespace S;
      @discriminator("kind") model Pet { kind: string; name: string; }
      model Cat extends Pet { kind: "cat"; }
      model Rock { weight: int32; }
      @discriminated(#{ envelope: "none", discriminatorPropertyName: "type" }) union Thing { pet: Pet, rock: Rock }
      model Box { thing: Thing; }
      @get op read(): Box;
    `);
    const found = diagnostics.filter((d) => d.code === "@abhigyakrishna/tspgen-go/unsupported-type");
    expect(found.some((d) => d.message.includes("nested discriminated models"))).toBe(true);
  });

  it("diagnoses names colliding with union and tagged codec members", async () => {
    const [, diagnostics] = await Tester.emit("@abhigyakrishna/tspgen-go", { module }).compileAndDiagnose(`
      @service namespace S;
      @discriminator("kind")
      model Pet { kind: string; }
      model Cat extends Pet { kind: "cat"; marshalJSON: string; }
      union U { a: string, A: int32 }
      model Box { pet: Pet; u: U; }
      @get op read(): Box;
    `);
    const duplicates = diagnostics.filter((d) => d.code === "@abhigyakrishna/tspgen-go/duplicate-name").map((d) => d.message);
    expect(duplicates).toHaveLength(2);
    expect(duplicates.some((message) => message.includes("MarshalJSON") && message.includes("S.Cat"))).toBe(true);
    expect(duplicates.some((message) => message.includes("S.U.a") && message.includes("S.U.A"))).toBe(true);
  });

  it("does not reference undeclared event stream unions", () => {
    const api = { types: [{ kind: "union", id: "S.Stream", name: "Stream", namespace: ["S"], variants: [], events: [] }] };
    expect(goType({ kind: "named", id: "S.Stream" }, api as unknown as ApiIR).text).toBe("any");
  });

  it("captures unknown variants with enum-unknown", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, features: { "enum-unknown": true },
    }).compile(fixture("unions.tsp"));
    expect(outputs["models/models.go"]).toContain("Unknown json.RawMessage");
    runGo(outputs, { "models/unions_unknown_test.go": fixture("unions-unknown_test.go") });
  }, 180000);

  it("sends and receives union bodies over net/http", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-go", {
      module, targets: [
        { [client]: { module: "example.com/unions/client" } },
        { [server]: { module: "example.com/unions/server" } },
      ],
    }).compile(`@service namespace S;
      @discriminator("kind") model Pet { kind: string; name: string; }
      model Cat extends Pet { kind: "cat"; lives?: int32 = 9; }
      model Dog extends Pet { kind: "dog"; good: boolean; }
      @post @route("/pets") op echo(@body pet: Pet): Pet;
    `);
    runGo(outputs, { "server/unions_http_test.go": fixture("unions-http_test.go") });
  }, 180000);
});
