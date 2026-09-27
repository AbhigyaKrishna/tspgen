import { expectDiagnostics } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { emitter } from "./tester.js";

const spec = `
  @service namespace S;
  /** A pet id. */
  @minLength(3) scalar PetId extends string;
  scalar Seen extends utcDateTime;
  model Pet { id: PetId = "abc"; @maxLength(10) \`alias\`?: PetId; seen: Seen; friends: PetId[] }
`;

const M = "models/com/acme/models";

describe("scalar-style", () => {
  it("inline (default) erases scalars to their base type", async () => {
    const { outputs } = await emitter().compile(spec);
    expect(outputs[`${M}/Pet.kt`]).toContain('    val id: String = "abc",\n');
    expect(outputs[`${M}/PetId.kt`]).toBeUndefined();
  });

  it("typealias declares each used scalar once and uses it", async () => {
    const { outputs } = await emitter({ "scalar-style": "typealias" }).compile(spec);
    expect(outputs[`${M}/PetId.kt`]).toContain("/**\n * A pet id.\n */\ntypealias PetId = String");
    expect(outputs[`${M}/Seen.kt`]).toContain("import java.time.Instant\n\ntypealias Seen = Instant");
    const pet = outputs[`${M}/Pet.kt`];
    expect(pet).toContain(`data class Pet(
    @EncodeDefault(EncodeDefault.Mode.ALWAYS)
    val id: PetId = "abc",
    val alias: PetId? = null,
    val seen: Seen,
    val friends: List<PetId>,
)`);
    // A typealias of a java.time class still needs its serializer in the files using it.
    expect(pet).toContain("@file:UseSerializers(InstantSerializer::class)");
    expect(pet).toContain('require(id.length >= 3) { "id must be at least 3 characters" }');
  });

  it("value-class wraps values; the class checks the scalar's constraints", async () => {
    const { outputs } = await emitter({ "scalar-style": "value-class" }).compile(spec);
    expect(outputs[`${M}/PetId.kt`]).toContain(`/**
 * A pet id.
 */
@Serializable
@JvmInline
value class PetId(val value: String) {
    init {
        require(value.length >= 3) { "PetId must be at least 3 characters" }
    }
}`);
    expect(outputs[`${M}/Seen.kt`]).toContain("@file:UseSerializers(InstantSerializer::class)");
    expect(outputs[`${M}/Seen.kt`]).toContain("value class Seen(val value: Instant)");
    const pet = outputs[`${M}/Pet.kt`];
    expect(pet).toContain('    val id: PetId = PetId("abc"),\n');
    expect(pet).toContain('require(alias == null || alias.value.length <= 10) { "alias must be at most 10 characters" }');
    expect(pet).not.toContain("length >= 3");
    expect(pet).not.toContain("UseSerializers");
  });

  it("the scalarStyle meta overrides the option per scalar", async () => {
    const { outputs } = await emitter().compile(`
      using TspGen;
      @service namespace S;
      @meta("kotlin", #{ scalarStyle: "value-class" }) scalar PetId extends string;
      scalar Tag extends string;
      model Pet { id: PetId; tag: Tag }
    `);
    expect(outputs[`${M}/PetId.kt`]).toContain("value class PetId(val value: String)");
    expect(outputs[`${M}/Tag.kt`]).toBeUndefined();
    expect(outputs[`${M}/Pet.kt`]).toContain("    val id: PetId,\n    val tag: String,\n");
  });

  it("value class: a nullable property with a default renders the bare (non-nullable) wrapper call", async () => {
    const { outputs } = await emitter({ "scalar-style": "value-class" }).compile(`
      @service namespace S;
      @minLength(2) scalar Code extends string;
      model Thing { code?: Code | null = "ab" }
    `);
    expect(outputs[`${M}/Thing.kt`]).toContain('    val code: Code? = Code("ab"),\n');
  });

  it("value class: the scalar's own @encode(string) fixes its wire encoding on the class itself", async () => {
    const { outputs } = await emitter({ "scalar-style": "value-class" }).compile(`
      @service namespace S;
      @encode(string) scalar BigId extends int64;
      model Thing { id: BigId }
    `);
    // BigId's own @encode(string) is always honoured by the value class.
    expect(outputs[`${M}/BigId.kt`]).toContain(
      "value class BigId(@Serializable(with = LongAsStringSerializer::class) val value: Long)",
    );
  });

  it("value class: a use's own @encode(string) wraps it in a generated <Name>AsStringSerializer, same wire", async () => {
    const { outputs } = await emitter({ "scalar-style": "value-class" }).compile(`
      @service namespace S;
      scalar Hits extends uint64;
      model Thing { @encode(string) hits: Hits; plain: Hits; @encode(string) opt?: Hits }
    `);
    expect(outputs[`${M}/Hits.kt`]).toContain("value class Hits(val value: ULong)");
    expect(outputs[`${M}/Thing.kt`]).toContain(`data class Thing(
    @Serializable(with = HitsAsStringSerializer::class)
    val hits: Hits,
    val plain: Hits,
    @Serializable(with = HitsAsStringSerializer::class)
    val opt: Hits? = null,
)`);
    const serializers = outputs[`${M}/ModelSerializers.kt`];
    expect(serializers).toContain(`/** Writes \`Hits\` as its wrapped ULong, as a JSON string (\`@encode(string)\` on a use). */
object HitsAsStringSerializer : KSerializer<Hits> {
    private val delegate = ULongAsStringSerializer

    override val descriptor: SerialDescriptor = delegate.descriptor

    override fun serialize(encoder: Encoder, value: Hits) = delegate.serialize(encoder, value.value)

    override fun deserialize(decoder: Decoder): Hits = Hits(delegate.deserialize(decoder))
}`);
    // ULongAsStringSerializer (HitsAsStringSerializer's delegate) is generated too, though no plain ULong uses it.
    expect(serializers).toContain("object ULongAsStringSerializer");
  });

  it("value class: a use's own @encode(string) on a decimal-based scalar is a no-op (already a JSON string)", async () => {
    const { outputs } = await emitter({ "scalar-style": "value-class" }).compile(`
      @service namespace S;
      scalar Price extends decimal;
      model Thing { @encode(string) price: Price }
    `);
    expect(outputs[`${M}/Thing.kt`]).toContain("    val price: Price,\n");
    expect(outputs[`${M}/ModelSerializers.kt`]).not.toContain("AsStringSerializer");
  });

  it("typealias/inline still honour a property's own @encode(string) per use", async () => {
    const spec2 = `
      @service namespace S;
      scalar Hits extends uint64;
      model Thing { @encode(string) hits: Hits; plain: Hits }
    `;
    const alias = await emitter({ "scalar-style": "typealias" }).compile(spec2);
    expect(alias.outputs[`${M}/Thing.kt`]).toContain(`data class Thing(
    @Serializable(with = ULongAsStringSerializer::class)
    val hits: Hits,
    val plain: Hits,
)`);
    const inline = await emitter().compile(spec2);
    expect(inline.outputs[`${M}/Thing.kt`]).toContain(`data class Thing(
    @Serializable(with = ULongAsStringSerializer::class)
    val hits: ULong,
    val plain: ULong,
)`);
  });

  it("reports an invalid scalarStyle meta", async () => {
    const [, diagnostics] = await emitter().compileAndDiagnose(`
      using TspGen;
      @service namespace S;
      @meta("kotlin", #{ scalarStyle: "wrapper" }) scalar PetId extends string;
      model Pet { id: PetId }
    `);
    expectDiagnostics(diagnostics, {
      code: "@abhigyakrishna/tspgen-core/invalid-meta",
      message: `Metadata key 'scalarStyle' on 'S.PetId' must be one of "inline", "typealias", "value-class"; it is ignored.`,
    });
  });
});
