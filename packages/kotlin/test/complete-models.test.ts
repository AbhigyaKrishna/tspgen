import { describe, expect, it } from "vitest";
import { emitter } from "./tester.js";

const models = "models/com/acme/models";

describe("Kotlin model wire contracts", () => {
  it("can preserve optional non-nullable fields without accepting explicit null", async () => {
    const { outputs } = await emitter({ features: { "strict-optionals": true } }).compile(`
      @service namespace S;
      model Options { name?: string; nested?: Options; maybe?: string | null; }
      model Defaults { options: Options = #{ name: "ok" }; }
    `);
    const options = outputs[`${models}/Options.kt`];
    expect(options).toContain("OptionalValue<String>");
    expect(options).toContain("OptionalValue<Options>");
    expect(options).toContain("OptionalValue<String?>");
    expect(outputs[`${models}/Defaults.kt`]).toContain('OptionalValue.Present("ok")');
  });

  it("retains typed additional properties, including generic and inherited records", async () => {
    const { outputs } = await emitter().compile(`
      @service namespace S;
      model Open<T> { name: string; ...Record<T>; }
      model Child extends Open<int32> { count: int32; }
      model Holder { item: Open<string>; }
    `);
    expect(outputs[`${models}/OpenString.kt`]).toContain("val additionalProperties: Map<String, String> = emptyMap()");
    expect(outputs[`${models}/OpenString.kt`]).toContain("JsonObject");
    expect(outputs[`${models}/Child.kt`]).toContain("val additionalProperties: Map<String, Int> = emptyMap()");
  });

  it("represents numeric and mixed enums with exact JSON values when enabled", async () => {
    const { outputs } = await emitter({ features: { "numeric-enums": true } }).compile(`
      @service namespace S;
      enum Code { ok: 1, failed: 2 }
      enum Mixed { automatic: "auto", count: 3 }
      model Holder { code: Code = Code.ok; mixed: Mixed; }
    `);
    expect(outputs[`${models}/Code.kt`]).toContain("enum class Code");
    expect(outputs[`${models}/Code.kt`]).toContain("JsonPrimitive(1)");
    expect(outputs[`${models}/Mixed.kt`]).toContain('JsonPrimitive("auto")');
    expect(outputs[`${models}/Holder.kt`]).toContain("val code: Code = Code.OK");
  });

  it("preserves discriminator envelopes without changing payload model types", async () => {
    const { outputs } = await emitter().compile(`
      @service namespace S;
      model Pet { name: string; }
      @discriminated(#{ discriminatorPropertyName: "kind", envelopePropertyName: "payload" })
      union Result { pet: Pet, message: string }
    `);
    const result = outputs[`${models}/Result.kt`];
    expect(result).toContain("sealed interface Result");
    expect(result).toContain('"kind"');
    expect(result).toContain('"payload"');
    expect(result).toContain("JsonObject");
  });

  it("preserves tuple order and length rather than emitting unknown", async () => {
    const { outputs } = await emitter().compile(`
      @service namespace S;
      model Location { point: [float64, float64]; metadata: [string, int32, boolean]; }
    `);
    const files = Object.values(outputs).join("\n");
    expect(files).toContain("JsonArray");
    expect(files).toContain("val item1: Double");
    expect(files).toContain("val item3: Boolean");
    expect(outputs[`${models}/Location.kt`]).not.toContain("JsonElement");
  });

  it("specializes tuples nested in generic models", async () => {
    const { outputs } = await emitter().compile(`
      @service namespace S;
      model Box<T> { pair: [T, string]; }
      model Root { value: Box<int32>; other: Box<boolean>; }
    `);
    const generated = Object.values(outputs).join("\n");
    expect(generated).toContain("val item1: Int");
    expect(generated).toContain("val item1: Boolean");
    expect(generated).not.toContain("val item1: T");
  });

  it("offers arbitrary precision without changing the default numeric APIs", async () => {
    const spec = `@service namespace S; model Numbers { count: integer; exact: numeric; @encode(string) external: integer; }`;
    const { outputs } = await emitter({ features: { "precise-numbers": true } }).compile(spec);
    expect(outputs[`${models}/Numbers.kt`]).toContain("val count: BigInteger");
    expect(outputs[`${models}/Numbers.kt`]).toContain("val exact: BigDecimal");
    expect(outputs[`${models}/NumberSerializers.kt`]).toContain("BigIntegerAsStringSerializer");
    const legacy = await emitter().compile(`@service namespace S; model Numbers { count: integer; exact: numeric; }`);
    expect(legacy.outputs[`${models}/Numbers.kt`]).toContain("val count: Long");
    expect(legacy.outputs[`${models}/Numbers.kt`]).toContain("val exact: Double");
  });

  it("generates nested collection/model defaults and validates literal values", async () => {
    const { outputs } = await emitter().compile(`
      @service namespace S;
      model Config { enabled: boolean; }
      model Settings {
        kind: "settings";
        version: 2;
        tags: string[] = #["a", "b"];
        config: Config = #{ enabled: true };
        labels: Record<string> = #{ region: "east" };
      }
    `);
    const settings = outputs[`${models}/Settings.kt`];
    expect(settings).toContain('listOf("a", "b")');
    expect(settings).toContain("Config(enabled = true)");
    expect(settings).toContain('mapOf("region" to "east")');
    expect(settings).toContain('kind == "settings"');
    expect(settings).toContain("version == 2");
  });

  it("keeps known values of extensible string unions when enabled", async () => {
    const { outputs } = await emitter({ features: { "open-enums": true } }).compile(`
      @service namespace S;
      union State { ready: "ready", other: string }
    `);
    const state = outputs[`${models}/State.kt`];
    expect(state).toContain("value class State(val value: String)");
    expect(state).toContain('State("ready")');
  });
});
