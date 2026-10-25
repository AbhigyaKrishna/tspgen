import { expectDiagnostics } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { emitter } from "./tester.js";

const models = "models/com/acme/models";

describe("client model fidelity", () => {
  it("tracks presence for optional nullable fields without changing other fields", async () => {
    const { outputs } = await emitter({ features: { "optional-presence": true } }).compile(`
      @service namespace S;
      model Patch { name?: string | null; count?: int32; required: string | null; }
    `);
    expect(outputs[`${models}/Patch.kt`]).toContain("val name: OptionalValue<String?> = OptionalValue.Absent");
    expect(outputs[`${models}/Patch.kt`]).toContain("@EncodeDefault(EncodeDefault.Mode.NEVER)");
    expect(outputs[`${models}/Patch.kt`]).toContain("val count: Int? = null");
    expect(outputs[`${models}/OptionalValue.kt`]).toContain("data class Present<T>(val value: T)");
  });

  it("keeps presence wrappers opt-in", async () => {
    const { outputs } = await emitter().compile(`@service namespace S; model Patch { name?: string | null; }`);
    expect(outputs[`${models}/Patch.kt`]).toContain("val name: String? = null");
    expect(outputs[`${models}/OptionalValue.kt`]).toBeUndefined();
  });

  it("models literal null without widening to JsonElement or warning", async () => {
    const { outputs } = await emitter().compile(`@service namespace S; model Empty { value: null; }`);
    expect(outputs[`${models}/Empty.kt`]).toContain("val value: JsonNull");
  });

  it("generates JSON-shaped unions with ambiguity checks", async () => {
    const { outputs } = await emitter({ features: { "untagged-unions": true } }).compile(`
      @service namespace S;
      enum Level { Read, Write }
      model Specific { level: Level; scopes: string[] }
      union Permission { simple: Level, specific: Specific }
    `);
    const permission = outputs[`${models}/Permission.kt`];
    expect(permission).toContain("sealed interface Permission");
    expect(permission).toContain("data class Simple(val value: Level)");
    expect(permission).toContain("matches.size != 1");
    expect(permission).toContain("output.json.encodeToJsonElement<com.acme.models.Specific>(value.value)");
  });

  it("retains only selected operation types and explicitly included extra roots", async () => {
    const { outputs } = await emitter({
      "model-collection": "reachable",
      "include-operations": ["S.Api.get"],
      "include-types": ["S.Extra"],
    }).compile(`
      @service namespace S;
      model Item { next?: Item; }
      model Extra { value: string }
      model Unused { secret: string }
      interface Api { @get @route("/item") get(): Item; @get @route("/unused") other(): Unused; }
    `);
    expect(outputs[`${models}/Item.kt`]).toBeDefined();
    expect(outputs[`${models}/Extra.kt`]).toBeDefined();
    expect(outputs[`${models}/Unused.kt`]).toBeUndefined();
  });

  it("rejects unknown selections instead of silently generating an empty client", async () => {
    const [, diagnostics] = await emitter({ "include-operations": ["S.missing"] }).compileAndDiagnose(
      `@service namespace S; @get op get(): string;`,
    );
    expectDiagnostics(diagnostics, [{ code: "@abhigyakrishna/tspgen-core/invalid-selection" }]);
  });

  it("retains bases, derived variants and used scalars while pruning unused scalar classes", async () => {
    const { outputs } = await emitter({ "model-collection": "reachable", "scalar-style": "value-class" }).compile(`
      @service namespace S;
      scalar Id extends string;
      scalar UnusedId extends string;
      model Unused { id: UnusedId; }
      @discriminator("kind") model Base { kind: string; id: Id; }
      model Child extends Base { kind: "child"; }
      @get op get(): Base;
    `);
    expect(outputs[`${models}/Base.kt`]).toBeDefined();
    expect(outputs[`${models}/Child.kt`]).toBeDefined();
    expect(outputs[`${models}/Id.kt`]).toBeDefined();
    expect(outputs[`${models}/UnusedId.kt`]).toBeUndefined();
  });

  it("reports a collision with the optional presence runtime", async () => {
    const [, diagnostics] = await emitter({ features: { "optional-presence": true } }).compileAndDiagnose(`
      @service namespace S;
      model OptionalValueSerializer { value: string; }
      model Patch { value?: string | null; }
    `);
    expectDiagnostics(diagnostics, [{ code: "@abhigyakrishna/tspgen-kotlin/duplicate-type-name" }]);
  });
});
