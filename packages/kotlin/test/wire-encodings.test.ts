import { describe, expect, it } from "vitest";
import { emitter } from "./tester.js";

const spec = `
  @service namespace S;
  @encode("unixTimestamp", int64) scalar Epoch extends utcDateTime;
  @encode("seconds", float64) scalar Seconds extends duration;
  scalar NativeEpoch extends unixTimestamp32;
  model Encoded {
    @encode("rfc7231") date: utcDateTime;
    epoch: Epoch;
    @encode("rfc3339") reset: Epoch;
    values: Seconds[];
    @encode("milliseconds", int32) elapsed: duration;
    @encode("base64url") bytes: bytes;
    standard: unixTimestamp32;
    inheritedStandard: NativeEpoch;
    @encode(string) enabled: boolean;
    @encode(string) count: int32;
    @encode(ArrayEncoding.pipeDelimited) tags: string[];
  }
`;

describe("standard wire encodings", () => {
  it.each(["java.time", "kotlin.time"])("preserves date/duration encodings with %s types", async (dateTime) => {
    const { outputs } = await emitter({ "date-time": dateTime }).compile(spec);
    const codecs = outputs["models/com/acme/models/EncodingSerializers.kt"];
    expect(codecs).toContain("RFC_1123_DATE_TIME");
    expect(codecs).toContain("raw.longValueExact()");
    expect(codecs).toContain("raw.movePointLeft(3)");
    expect(codecs).toContain('java.math.BigDecimal("2147483647")');
    expect(codecs).toContain("Expected whole encoded units");
    expect(codecs).toContain("raw.lowercase(java.util.Locale.ROOT)");
    expect(codecs).toContain("raw.toInt()");
    expect(codecs).toContain('raw.split("|")');
    expect(outputs["models/com/acme/models/Encoded.kt"]).toContain("@Serializable(with =");
    expect(outputs["models/com/acme/models/Encoded.kt"]).toContain("val bytes: String");
    expect(codecs).toContain(dateTime === "java.time" ? "java.time.Instant.parse(raw)" : "kotlin.time.Instant.parse(raw)");
  });

  it("adapts value-class scalars to a property's explicit encoding", async () => {
    const { outputs } = await emitter({ "scalar-style": "value-class" }).compile(spec);
    const codecs = outputs["models/com/acme/models/EncodingSerializers.kt"];
    expect(outputs["models/com/acme/models/Epoch.kt"]).toContain("@Serializable(with = java_time_Instant_unixTimestamp_int64Serializer::class)");
    expect(codecs).toContain("com.acme.models.Epoch(java.time.Instant.parse(raw))");
    expect(codecs).toContain("value.value");
  });
});
