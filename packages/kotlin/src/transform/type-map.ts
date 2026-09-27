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
  uint64: ["ULong"],
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

export type DecimalMapping = "big-decimal" | "string";

/** `decimal: big-decimal` for decimal and decimal128. */
const BIG_DECIMAL: [string, string] = ["BigDecimal", "java.math.BigDecimal"];

/** java.time classes the models serialize as ISO-8601 strings, each with a generated `<Name>Serializer`. */
export const JAVA_TIME_CLASSES: readonly string[] = Object.values(JAVA_TIME).map(([, fqn]) => fqn);

/**
 * `java.time` types have no kotlinx serializer, so request parameters and headers of those types are
 * parsed with `X.parse(...)` and written with `toString()` (both ISO-8601). Undefined for other types.
 */
export function javaTimeCodec(typeText: string, imports: readonly string[]): { parse: string; encode: string } | undefined {
  // Written qualified (`java.time.Duration`) when a generated type has the same simple name.
  const fqn = typeText.startsWith("java.time.") ? typeText : `java.time.${typeText}`;
  if (!JAVA_TIME_CLASSES.includes(fqn) || (fqn !== typeText && !imports.includes(fqn))) return undefined;
  return { parse: `${typeText}.parse(it)`, encode: "toString()" };
}

/** Classes the models serialize with a generated serializer in ModelSerializers.kt: java.time as ISO-8601 strings, BigDecimal as a decimal string. */
export const SERIALIZED_CLASSES: readonly string[] = [...JAVA_TIME_CLASSES, "java.math.BigDecimal"];

/** Serialized classes (see SERIALIZED_CLASSES) a type use refers to, imported or written qualified. */
export function serializedIn(type: KtTypeUse): string[] {
  const qualified: string[] = type.text.match(/java\.(?:time|math)\.[A-Za-z]+/g) ?? [];
  return SERIALIZED_CLASSES.filter((fqn) => type.imports.includes(fqn) || qualified.includes(fqn) || type.needs?.includes(fqn));
}

export const JSON_ELEMENT: KtTypeUse = {
  text: "JsonElement",
  imports: ["kotlinx.serialization.json.JsonElement"],
  nullable: false,
};

export function scalarTypeUse(
  name: string,
  dateTime: DateTimeMapping = "kotlin.time",
  decimal: DecimalMapping = "big-decimal",
): KtTypeUse {
  const bigDecimal = decimal === "big-decimal" && (name === "decimal" || name === "decimal128") ? BIG_DECIMAL : undefined;
  const [text, fqn] = (dateTime === "java.time" ? JAVA_TIME[name] : undefined) ?? bigDecimal ?? SCALARS[name] ?? ["String"];
  return { text, imports: fqn ? [fqn] : [], nullable: false };
}

/** `java.util.UUID` → `UUID` + import; names without a package are used verbatim. */
export function fqnTypeUse(fqn: string): KtTypeUse {
  const dot = fqn.lastIndexOf(".");
  if (dot < 0 || fqn.includes("<")) return { text: fqn, imports: [], nullable: false };
  return { text: fqn.slice(dot + 1), imports: [fqn], nullable: false };
}

export function nullable(type: KtTypeUse): KtTypeUse {
  if (type.nullable) return type;
  return { ...type, text: `${type.text}?`, nullable: true, ...(type.serialText ? { serialText: `${type.serialText}?` } : {}) };
}

/** A container element as written in a model: its `serialText`, or its serializer as a type annotation. */
function serialElement(item: KtTypeUse): string | undefined {
  if (item.serialText) return item.serialText;
  return item.serializer ? `@Serializable(with = ${item.serializer}::class) ${item.text}` : undefined;
}

function serialFields(item: KtTypeUse, wrap: (element: string) => string): Pick<KtTypeUse, "serialText" | "serialImports"> {
  const element = serialElement(item);
  return element ? { serialText: wrap(element), serialImports: item.serialImports ?? [] } : {};
}

export function listOf(item: KtTypeUse): KtTypeUse {
  return {
    text: `List<${item.text}>`,
    imports: item.imports,
    nullable: false,
    element: item,
    ...serialFields(item, (e) => `List<${e}>`),
    ...(item.needs ? { needs: item.needs } : {}),
  };
}

export function mapOf(value: KtTypeUse): KtTypeUse {
  return {
    text: `Map<String, ${value.text}>`,
    imports: value.imports,
    nullable: false,
    ...serialFields(value, (e) => `Map<String, ${e}>`),
    ...(value.needs ? { needs: value.needs } : {}),
  };
}

/** `Page` + [`Pet`] → `Page<Pet>` carrying the imports of both. */
export function genericOf(base: KtTypeUse, args: readonly KtTypeUse[]): KtTypeUse {
  return {
    text: `${base.text}<${args.map((a) => a.text).join(", ")}>`,
    imports: [...base.imports, ...args.flatMap((a) => a.imports)],
    nullable: false,
    ...(args.some((a) => a.needs) ? { needs: args.flatMap((a) => a.needs ?? []) } : {}),
  };
}
