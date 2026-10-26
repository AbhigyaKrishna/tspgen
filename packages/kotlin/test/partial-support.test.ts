import { describe, expect, it } from "vitest";
import { emitter } from "./tester.js";

const directory = "models/com/acme/models";

describe("Kotlin partial feature completion", () => {
  it("preserves numeric decimal wire kinds and explicit string encodings", async () => {
    const { outputs } = await emitter({ features: { "precise-numbers": true } }).compile(`
      @service namespace S;
      model Amounts { value: decimal; @encode(string) text: decimal128; }
    `);
    expect(outputs[`${directory}/Amounts.kt`]).toContain("NumericSerializer::class");
    expect(outputs[`${directory}/Amounts.kt`]).toContain("BigDecimalAsStringSerializer::class");
    const strings = await emitter({ decimal: "string", features: { "precise-numbers": true } }).compile(`
      @service namespace S; model Amounts { value: decimal; }
    `);
    expect(strings.outputs[`${directory}/Amounts.kt`]).toContain("DecimalTextSerializer::class");
  });

  it("retains exact bounds beyond JavaScript precision and temporal bounds", async () => {
    const { outputs } = await emitter({ features: { "precise-numbers": true } }).compile(`
      @service namespace S;
      @minValue(123456789012345678901234567890) scalar Big extends integer;
      model Limits {
        values: Big[];
        @maxValueExclusive(0.1234567890123456789012345) fraction: numeric;
        @minValue(utcDateTime.fromISO("2025-01-01T00:00:00Z")) date: utcDateTime;
      }
    `);
    const limits = outputs[`${directory}/Limits.kt`];
    expect(limits).toContain('BigInteger("123456789012345678901234567890")');
    expect(limits).toContain('BigDecimal("0.1234567890123456789012345")');
    expect(limits).toContain('java.time.Instant.parse("2025-01-01T00:00:00Z")');
  });

  it("keeps docs and deprecation on properties with custom JSON codecs and numeric enum members", async () => {
    const { outputs } = await emitter({ features: { "numeric-enums": true, "untagged-unions": true, "open-enums": true } }).compile(`
      @service namespace S;
      model Open { @doc("Old label.") #deprecated "Use displayName."
        label: string; ...Record<unknown>; }
      enum Code { @doc("Old code.") #deprecated "Use next."
        old: 1, next: 2 }
      union Choice { @doc("Old choice.") #deprecated "Use number."
        text: string, number: int32 }
      union State { @doc("Old state.") #deprecated "Use next."
        old: "old", string }
      @discriminator("kind") model Animal { kind: string; #deprecated "Use label."
        name: string; }
      model Cat extends Animal { kind: "cat"; }
    `);
    expect(outputs[`${directory}/Open.kt`]).toContain('@Deprecated("Use displayName.")');
    expect(outputs[`${directory}/Code.kt`]).toContain('@Deprecated("Use next.")');
    expect(outputs[`${directory}/Open.kt`]).toContain("Old label.");
    expect(outputs[`${directory}/Choice.kt`]).toContain('@Deprecated("Use number.")');
    expect(outputs[`${directory}/State.kt`]).toContain('@Deprecated("Use next.")');
    expect(outputs[`${directory}/State.kt`]).toContain("Old state.");
    expect(outputs[`${directory}/Animal.kt`]).toContain('@Deprecated("Use label.")');
  });

  it("specializes inherited models and template unions without losing concrete types", async () => {
    const { outputs } = await emitter({ features: { "untagged-unions": true } }).compile(`
      @service namespace S;
      model Base<T> { value: T; }
      model Derived<T> extends Base<T> { pair: [T, string]; }
      model Failure { reason: string; }
      union Outcome<T> { value: T, failure: Failure }
      model Root { number: Derived<int32>; text: Derived<string>; outcome: Outcome<int32>; }
    `);
    const generated = Object.values(outputs).join("\n");
    expect(generated).toContain("val value: Int");
    expect(generated).toContain("val value: String");
    expect(generated).toContain("val item1: Int");
    expect(generated).toContain("val item1: String");
    expect(outputs[`${directory}/OutcomeInt32.kt`]).toContain("val value: com.acme.models.Failure");
    expect(outputs[`${directory}/Root.kt`]).toContain("val outcome: OutcomeInt32");
    expect(outputs[`${directory}/DerivedInt32.kt`]).not.toContain("val value: T");
    expect(outputs[`${directory}/DerivedString.kt`]).not.toContain("val value: T");
  });
});
