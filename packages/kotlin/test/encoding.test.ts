import { describe, expect, it } from "vitest";
import { emitter } from "./tester.js";

const spec = `
  @service namespace S;
  @encode(string) scalar BigId extends int64;
  model Account {
    @encode(string) id: int64;
    @encode(string) total?: uint64;
    ids: BigId[];
    byName: Record<BigId>;
    plain: int64;
    @encode(string) amount: decimal;
  }
`;

describe("@encode(string)", () => {
  it("serializes Long and ULong as JSON strings, also inside containers", async () => {
    const { outputs } = await emitter().compile(spec);
    const account = outputs["models/com/acme/models/Account.kt"];
    expect(account).toContain(`data class Account(
    @Serializable(with = LongAsStringSerializer::class)
    val id: Long,
    @Serializable(with = ULongAsStringSerializer::class)
    val total: ULong? = null,
    val ids: List<@Serializable(with = LongAsStringSerializer::class) Long>,
    val byName: Map<String, @Serializable(with = LongAsStringSerializer::class) Long>,
    val plain: Long,
    val amount: BigDecimal,
)`);
    expect(account).toContain("import kotlinx.serialization.builtins.LongAsStringSerializer\n");
    expect(outputs["models/com/acme/models/ModelSerializers.kt"]).toContain(`/** Writes \`ULong\` as a JSON string (\`@encode(string)\` on uint64). */
object ULongAsStringSerializer : KSerializer<ULong> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("com.acme.models.ULongAsString", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, value: ULong) = encoder.encodeString(value.toString())

    override fun deserialize(decoder: Decoder): ULong = decoder.decodeString().toULong()
}`);
  });

  it("emits ModelSerializers.kt for ULongAsStringSerializer alone, without a module", async () => {
    const { outputs } = await emitter().compile(`@service namespace S; model C { @encode(string) n: uint64 }`);
    const serializers = outputs["models/com/acme/models/ModelSerializers.kt"];
    expect(serializers).toContain("object ULongAsStringSerializer");
    expect(serializers).not.toContain("modelSerializersModule");
    expect(serializers).not.toContain("import kotlinx.serialization.modules.SerializersModule");
  });
});
