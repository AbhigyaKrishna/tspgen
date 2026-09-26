import type { KtTypeUse } from "./model.js";

/** TypeSpec std scalar → [Kotlin simple name, import]. */
const SCALARS: Record<string, [string, string?]> = {
  string: ["String"],
  boolean: ["Boolean"],
  bytes: ["String"],
  url: ["String"],
  int8: ["Byte"],
  int16: ["Short"],
  int32: ["Int"],
  int64: ["Long"],
  integer: ["Long"],
  safeint: ["Long"],
  uint8: ["Short"],
  uint16: ["Int"],
  uint32: ["Long"],
  uint64: ["Long"],
  float32: ["Float"],
  float64: ["Double"],
  float: ["Double"],
  numeric: ["Double"],
  decimal: ["String"],
  decimal128: ["String"],
  utcDateTime: ["Instant", "kotlin.time.Instant"],
  offsetDateTime: ["String"],
  plainDate: ["LocalDate", "kotlinx.datetime.LocalDate"],
  plainTime: ["LocalTime", "kotlinx.datetime.LocalTime"],
  duration: ["Duration", "kotlin.time.Duration"],
};

/** `date-time: java.time` overrides of SCALARS. */
const JAVA_TIME: Record<string, [string, string]> = {
  utcDateTime: ["Instant", "java.time.Instant"],
  offsetDateTime: ["OffsetDateTime", "java.time.OffsetDateTime"],
  plainDate: ["LocalDate", "java.time.LocalDate"],
  plainTime: ["LocalTime", "java.time.LocalTime"],
  duration: ["Duration", "java.time.Duration"],
};

export type DateTimeMapping = "java.time" | "kotlin.time";

/** java.time classes the models serialize as ISO-8601 strings, each with a generated `<Name>Serializer`. */
export const JAVA_TIME_CLASSES: readonly string[] = Object.values(JAVA_TIME).map(([, fqn]) => fqn);

/**
 * `java.time` types have no kotlinx serializer, so request parameters and headers of those types are
 * parsed with `X.parse(...)` and written with `toString()` (both ISO-8601). Undefined for other types.
 */
export function javaTimeCodec(typeText: string, imports: readonly string[]): { parse: string; encode: string } | undefined {
  if (!imports.includes(`java.time.${typeText}`) || !JAVA_TIME_CLASSES.includes(`java.time.${typeText}`)) return undefined;
  return { parse: `${typeText}.parse(it)`, encode: "toString()" };
}

export const JSON_ELEMENT: KtTypeUse = {
  text: "JsonElement",
  imports: ["kotlinx.serialization.json.JsonElement"],
  nullable: false,
};

export function scalarTypeUse(name: string, dateTime: DateTimeMapping = "kotlin.time"): KtTypeUse {
  const [text, fqn] = (dateTime === "java.time" ? JAVA_TIME[name] : undefined) ?? SCALARS[name] ?? ["String"];
  return { text, imports: fqn ? [fqn] : [], nullable: false };
}

/** `java.util.UUID` → `UUID` + import; names without a package are used verbatim. */
export function fqnTypeUse(fqn: string): KtTypeUse {
  const dot = fqn.lastIndexOf(".");
  if (dot < 0 || fqn.includes("<")) return { text: fqn, imports: [], nullable: false };
  return { text: fqn.slice(dot + 1), imports: [fqn], nullable: false };
}

export function nullable(type: KtTypeUse): KtTypeUse {
  return type.nullable ? type : { ...type, text: `${type.text}?`, nullable: true };
}

export function listOf(item: KtTypeUse): KtTypeUse {
  return { text: `List<${item.text}>`, imports: item.imports, nullable: false };
}

export function mapOf(value: KtTypeUse): KtTypeUse {
  return { text: `Map<String, ${value.text}>`, imports: value.imports, nullable: false };
}

/** `Page` + [`Pet`] → `Page<Pet>` carrying the imports of both. */
export function genericOf(base: KtTypeUse, args: readonly KtTypeUse[]): KtTypeUse {
  return {
    text: `${base.text}<${args.map((a) => a.text).join(", ")}>`,
    imports: [...base.imports, ...args.flatMap((a) => a.imports)],
    nullable: false,
  };
}
