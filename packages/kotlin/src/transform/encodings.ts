import type { WireEncodingIR } from "@abhigyakrishna/tspgen-core";
import { qualifyText } from "../imports.js";
import type { KtTypeUse } from "./model.js";
import { kotlinString } from "../kotlin-string.js";
import { jsonSerializer, serializedIn, serializerImports } from "./type-map.js";

interface ExplicitEncodingSerializer {
  name: string;
  type: string;
  wire: "string" | "number";
  decode: string;
  encode: string;
  integer?: boolean;
  minimum?: string;
  maximum?: string;
}

export type EncodingSerializer = ExplicitEncodingSerializer | { name: string; type: string; delegate: string };

const INTEGER_BOUNDS: Record<string, [string, string]> = {
  int8: ["-128", "127"], int16: ["-32768", "32767"], int32: ["-2147483648", "2147483647"],
  int64: ["-9223372036854775808", "9223372036854775807"], safeint: ["-9007199254740991", "9007199254740991"],
  uint8: ["0", "255"], uint16: ["0", "65535"], uint32: ["0", "4294967295"], uint64: ["0", "18446744073709551615"],
};

/** Wire codecs are separate from Kotlin type mapping: the same Instant can use several encodings. */
export class EncodingBuilder {
  readonly serializers = new Map<string, EncodingSerializer>();
  private readonly arrays = new Map<string, string>();

  constructor(private readonly modelsPackage: string) {}

  array(type: KtTypeUse, delimiter: string | undefined): KtTypeUse {
    if (delimiter === undefined || !type.element) return type;
    const element = type.element;
    const serializer = qualifyText(jsonSerializer(element), [
      ...element.imports, ...serializerImports(element),
      ...serializedIn(element).map((fqn) => `${this.modelsPackage}.${fqn.split(".").at(-1)}Serializer`),
      "kotlinx.serialization.builtins.ListSerializer", "kotlinx.serialization.builtins.MapSerializer",
    ]);
    const qualified = qualifyText(type.text, type.imports);
    const key = `${qualified}:${serializer}:${delimiter}`;
    const existing = this.arrays.get(key);
    if (existing) return this.withSerializer(type, existing);
    const name = `Delimited${this.arrays.size + 1}Serializer`;
    this.arrays.set(key, name);
    const separator = kotlinString(delimiter);
    this.serializers.set(name, { name, type: qualified, wire: "string",
      decode: `if (raw.isEmpty()) emptyList() else raw.split(${separator}).map { decodeDelimitedElement(${serializer}, it) }`,
      encode: `value.joinToString(${separator}) { encodeDelimitedElement(${serializer}, it, ${separator}) }`,
    });
    return this.withSerializer(type, name);
  }

  typeUse(type: KtTypeUse, root: string, encoding: WireEncodingIR | undefined): KtTypeUse {
    if (!encoding || root === "bytes") return type;
    const qualified = qualifyText(type.text, type.imports);
    let expressions: Pick<ExplicitEncodingSerializer, "decode" | "encode">;
    if (encoding.name === "string") expressions = stringExpressions(qualified);
    else if (root === "duration") expressions = durationExpressions(qualified, encoding.name);
    else expressions = dateExpressions(qualified, encoding.name);
    const name = `${qualified.replaceAll(".", "_")}_${encoding.name}_${encoding.type}Serializer`;
    const bounds = INTEGER_BOUNDS[encoding.type];
    this.serializers.set(name, {
      name, type: qualified, wire: encoding.type === "string" ? "string" : "number", ...expressions,
      ...(bounds || encoding.type === "integer" ? { integer: true } : {}),
      ...(bounds ? { minimum: bounds[0], maximum: bounds[1] } : {}),
    });
    return this.withSerializer(type, name);
  }

  wrap(type: KtTypeUse, underlying: KtTypeUse): KtTypeUse {
    if (!underlying.serializer) return type;
    const codec = this.serializers.get(underlying.serializer);
    const qualified = qualifyText(type.text, type.imports);
    const name = `${qualified.replaceAll(".", "_")}_${underlying.serializer}`;
    if (codec && !("delegate" in codec)) {
      this.serializers.set(name, { ...codec, name, type: qualified,
        decode: `${qualified}(${codec.decode})`, encode: codec.encode.replaceAll("value", "value.value") });
    } else {
      this.serializers.set(name, { name, type: qualified,
        delegate: qualifyText(jsonSerializer(underlying), serializerImports(underlying)) });
    }
    return this.withSerializer(type, name);
  }

  private withSerializer(type: KtTypeUse, name: string): KtTypeUse {
    return { ...type, serializer: name, encodedParam: true,
      serialImports: ["kotlinx.serialization.Serializable", `${this.modelsPackage}.${name}`] };
  }
}

function stringExpressions(type: string): Pick<ExplicitEncodingSerializer, "decode" | "encode"> {
  const parse: Record<string, string> = {
    Byte: "toByte()", Short: "toShort()", Int: "toInt()", Long: "toLong()", ULong: "toULong()",
    Float: "toFloat()", Double: "toDouble()", "java.math.BigInteger": "toBigInteger()", "java.math.BigDecimal": "toBigDecimal()",
  };
  return { encode: "value.toString()", decode: type === "Boolean"
    ? 'when (raw.lowercase(java.util.Locale.ROOT)) { "true" -> true; "false" -> false; else -> throw IllegalArgumentException("Expected true or false") }'
    : `raw.${parse[type]}` };
}

function dateExpressions(type: string, encoding: string): Pick<ExplicitEncodingSerializer, "decode" | "encode"> {
  if (encoding === "rfc3339") return {
    decode: type === "String" ? "raw" : `${type}.parse(raw)`, encode: "value.toString()",
  };
  const offset = type === "java.time.OffsetDateTime" || type === "String";
  const instant = instantExpression(type);
  const parsed = encoding === "unixTimestamp"
    ? "java.time.Instant.ofEpochSecond(raw.longValueExact())"
    : "java.time.ZonedDateTime.parse(raw, java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME).toInstant()";
  let decode = parsed;
  if (type === "kotlin.time.Instant") decode = `kotlin.time.Instant.parse((${parsed}).toString())`;
  else if (offset) decode = `(${parsed}).atOffset(java.time.ZoneOffset.UTC)${type === "String" ? ".toString()" : ""}`;
  const encode = encoding === "unixTimestamp" ? `java.math.BigDecimal((${instant}).epochSecond)`
    : `java.time.format.DateTimeFormatter.ofPattern("EEE, dd MMM yyyy HH:mm:ss 'GMT'", java.util.Locale.US).withZone(java.time.ZoneOffset.UTC).format(${instant})`;
  return { decode, encode };
}

function instantExpression(type: string): string {
  if (type === "kotlin.time.Instant") return "java.time.Instant.ofEpochSecond(value.epochSeconds, value.nanosecondsOfSecond.toLong())";
  if (type === "String") return "java.time.OffsetDateTime.parse(value).toInstant()";
  if (type === "java.time.OffsetDateTime") return "value.toInstant()";
  return "value";
}

function durationExpressions(type: string, encoding: string): Pick<ExplicitEncodingSerializer, "decode" | "encode"> {
  if (encoding === "ISO8601") return {
    decode: `${type}.${type === "kotlin.time.Duration" ? "parseIsoString" : "parse"}(raw)`,
    encode: type === "kotlin.time.Duration" ? "value.toIsoString()" : "value.toString()",
  };
  const seconds = encoding === "milliseconds" ? "raw.movePointLeft(3)" : "raw";
  const parsed = `durationFromSeconds(${seconds})`;
  const duration = type === "kotlin.time.Duration" ? "java.time.Duration.parse(value.toIsoString())" : "value";
  const secondsValue = `durationSeconds(${duration})`;
  return {
    decode: type === "kotlin.time.Duration" ? `kotlin.time.Duration.parseIsoString(${parsed}.toString())` : parsed,
    encode: encoding === "milliseconds" ? `${secondsValue}.movePointRight(3)` : secondsValue,
  };
}
