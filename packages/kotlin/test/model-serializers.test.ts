import { buildApiIR } from "@abhigyakrishna/tspgen-core";
import { describe, expect, it } from "vitest";
import { transformToKotlin } from "../src/transform/index.js";
import { emitter, Tester } from "./tester.js";

describe("ModelSerializers.kt", () => {
  it("holds the java.time serializers and modelSerializersModule", async () => {
    const { outputs } = await emitter().compile(`@service namespace S; model Slot { at: utcDateTime }`);
    expect(outputs["models/com/acme/models/JavaTimeSerializers.kt"]).toBeUndefined();
    expect(outputs["models/com/acme/models/ModelSerializers.kt"]).toContain(`val modelSerializersModule: SerializersModule = SerializersModule {
    contextual(Instant::class, InstantSerializer)
}`);
    expect(outputs["models/com/acme/models/Slot.kt"]).toContain("@file:UseSerializers(InstantSerializer::class)");
  });

  it("exposes serializers and serializersModule on the IR", async () => {
    const [{ program }] = await Tester.compileAndDiagnose(`@service namespace S; model Slot { at: utcDateTime }`);
    const ir = transformToKotlin(program, buildApiIR(program), {
      package: "com.acme",
      enumMemberNaming: "UPPER_SNAKE",
      dateTime: "java.time",
    });
    expect(ir.serializers).toEqual(["java.time.Instant"]);
    expect(ir.serializersModule).toBe("com.acme.models.modelSerializersModule");
  });
});
