import { describe, expect, it } from "vitest";
import { client } from "./tester.js";

describe("ktor-client @meta keys", () => {
  it("annotates client methods from the ktor-client scope", async () => {
    const { outputs } = await client().compile(`
      using TspGen;
      @service namespace S;
      @route("/ping") @meta("kotlin:ktor-client", #{ annotations: #["@JvmSynthetic"] }) op ping(): void;
    `);
    expect(outputs["client/com/acme/client/SClient.kt"]).toContain(`    @JvmSynthetic
    suspend fun ping() {`);
  });
});
