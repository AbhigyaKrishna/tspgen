import { describe, expect, it } from "vitest";
import { emitter } from "./tester.js";

const spec = `
  @service namespace S;
  enum PetKind { dog, bird: "parrot" }
  union Size { "s", "m" }
  model Pet { kind: PetKind = PetKind.dog; size: Size }
`;

const on = { features: { "enum-unknown": true } };

describe("features.enum-unknown", () => {
  it("is off by default", async () => {
    const { outputs } = await emitter().compile(spec);
    expect(outputs["models/com/acme/models/PetKind.kt"]).toContain("@Serializable\nenum class PetKind {");
    expect(outputs["models/com/acme/models/PetKind.kt"]).not.toContain("UNKNOWN");
  });

  it("adds UNKNOWN and a serializer mapping unknown wire values to it", async () => {
    const { outputs } = await emitter(on).compile(spec);
    expect(outputs["models/com/acme/models/PetKind.kt"]).toContain(`@Serializable(with = PetKind.Serializer::class)
enum class PetKind {
    DOG,
    BIRD,

    /** A value this code does not know (e.g. added by a newer server); encoding it throws. */
    UNKNOWN;

    internal object Serializer : KSerializer<PetKind> {
        override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("com.acme.models.PetKind", PrimitiveKind.STRING)

        override fun serialize(encoder: Encoder, value: PetKind) {
            val wire = when (value) {
                PetKind.DOG -> "dog"
                PetKind.BIRD -> "parrot"
                PetKind.UNKNOWN -> throw SerializationException("PetKind.UNKNOWN has no wire value")
            }
            encoder.encodeString(wire)
        }

        override fun deserialize(decoder: Decoder): PetKind =
            when (decoder.decodeString()) {
                "dog" -> PetKind.DOG
                "parrot" -> PetKind.BIRD
                else -> PetKind.UNKNOWN
            }
    }
}`);
    expect(outputs["models/com/acme/models/PetKind.kt"]).not.toContain("@SerialName");
    expect(outputs["models/com/acme/models/PetKind.kt"]).toContain("import kotlinx.serialization.SerializationException\n");
    expect(outputs["models/com/acme/models/Size.kt"]).toContain("    UNKNOWN;");
    expect(outputs["models/com/acme/models/Pet.kt"]).toContain("    val kind: PetKind = PetKind.DOG,");
  });

  it("leaves numeric enums (typealiases) alone", async () => {
    // compileAndDiagnose: numeric enums warn `numeric-enum`, which `compile` would fail on.
    const [result] = await emitter(on).compileAndDiagnose(`@service namespace S; enum Level { low: 1 }`);
    expect(result.outputs["models/com/acme/models/Level.kt"]).toContain("typealias Level = Int");
  });

  it("is overridden per enum and per namespace with @meta", async () => {
    const { outputs } = await emitter().compile(`
      using TspGen;
      @service namespace S;
      @meta("kotlin", #{ features: #{ \`enum-unknown\`: true } }) enum PetKind { dog }
      enum Other { a }
      @meta("kotlin", #{ features: #{ \`enum-unknown\`: true } })
      namespace Responses { enum Tier { gold } }
    `);
    expect(outputs["models/com/acme/models/PetKind.kt"]).toContain("    UNKNOWN;");
    expect(outputs["models/com/acme/models/Other.kt"]).not.toContain("UNKNOWN");
    expect(outputs["models/com/acme/models/Tier.kt"]).toContain("    UNKNOWN;");
  });

  it("follows PascalCase member naming and avoids a clash with a real member", async () => {
    const pascal = await emitter({ ...on, naming: { "enum-members": "PascalCase" } }).compile(`@service namespace S; enum PetKind { dog }`);
    expect(pascal.outputs["models/com/acme/models/PetKind.kt"]).toContain("    Unknown;");
    const clash = await emitter(on).compile("@service namespace S; enum Status { `unknown`, ok }");
    expect(clash.outputs["models/com/acme/models/Status.kt"]).toContain("    UNKNOWN_;");
    expect(clash.outputs["models/com/acme/models/Status.kt"]).toContain('                "unknown" -> Status.UNKNOWN\n');
  });

  it("renames the nested Serializer object when a member is itself named Serializer", async () => {
    const { outputs } = await emitter({ ...on, naming: { "enum-members": "PascalCase" } }).compile(
      "@service namespace S; enum Weird { Serializer, other }",
    );
    const weird = outputs["models/com/acme/models/Weird.kt"];
    expect(weird).toContain(`@Serializable(with = Weird.Serializer_::class)
enum class Weird {
    Serializer,
    Other,

    /** A value this code does not know (e.g. added by a newer server); encoding it throws. */
    Unknown;

    internal object Serializer_ : KSerializer<Weird> {`);
    expect(weird).toContain('                Weird.Serializer -> "Serializer"');
    expect(weird).toContain('                "Serializer" -> Weird.Serializer');
  });
});
