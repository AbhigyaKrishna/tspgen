import { describe, expect, it } from "vitest";
import { emitter } from "./tester.js";

describe("uint64", () => {
  it("maps to ULong with unsigned defaults and bounds", async () => {
    const { outputs } = await emitter().compile(`
      @service namespace S;
      model Counter { @minValue(1) @maxValue(1000) hits: uint64; total?: uint64 = 5; all: uint64[] }
    `);
    const counter = outputs["models/com/acme/models/Counter.kt"];
    expect(counter).toContain(`data class Counter(
    val hits: ULong,
    val total: ULong = 5uL,
    val all: List<ULong>,
)`);
    expect(counter).toContain('if (!(hits >= 1uL)) throw ModelCheckException("hits must be at least 1")');
    expect(counter).toContain('if (!(hits <= 1000uL)) throw ModelCheckException("hits must be at most 1000")');
  });
});
