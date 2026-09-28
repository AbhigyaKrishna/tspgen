import { describe, expect, it } from "vitest";
import { emitter } from "./tester.js";

const spec = `
  @service namespace S;
  model Price { @minValue(0) @maxValue(1000.5) amount: decimal; tax?: decimal128 = 0.25; history: decimal[] }
`;

describe("decimal", () => {
  it("big-decimal (default): BigDecimal with a generated string serializer, bounds and defaults", async () => {
    const { outputs } = await emitter().compile(spec);
    const price = outputs["models/com/acme/models/Price.kt"];
    expect(price).toContain("@file:UseSerializers(BigDecimalSerializer::class)");
    expect(price).toContain("import java.math.BigDecimal\n");
    expect(price).toContain(`data class Price(
    val amount: BigDecimal,
    val tax: BigDecimal = BigDecimal("0.25"),
    val history: List<BigDecimal>,
)`);
    expect(price).toContain('if (!(amount >= BigDecimal("0"))) throw ModelCheckException("amount must be at least 0")');
    expect(price).toContain('if (!(amount <= BigDecimal("1000.5"))) throw ModelCheckException("amount must be at most 1000.5")');
    const serializers = outputs["models/com/acme/models/ModelSerializers.kt"];
    expect(serializers).toContain(`/** Writes \`BigDecimal\` as a JSON string (\`toPlainString()\`); reads a JSON string or number. */
object BigDecimalSerializer : KSerializer<BigDecimal> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("java.math.BigDecimal", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, value: BigDecimal) = encoder.encodeString(value.toPlainString())

    override fun deserialize(decoder: Decoder): BigDecimal =
        BigDecimal(if (decoder is JsonDecoder) decoder.decodeJsonElement().jsonPrimitive.content else decoder.decodeString())
}`);
    expect(serializers).toContain("    contextual(BigDecimal::class, BigDecimalSerializer)\n");
    expect(serializers).toContain("import kotlinx.serialization.json.JsonDecoder\n");
    expect(serializers).toContain("import kotlinx.serialization.json.jsonPrimitive\n");
  });

  it("string keeps 0.1.x output", async () => {
    const { outputs } = await emitter({ decimal: "string" }).compile(spec);
    expect(outputs["models/com/acme/models/Price.kt"]).toContain("    val amount: String,\n");
    expect(outputs["models/com/acme/models/ModelSerializers.kt"]).toBeUndefined();
  });
});
