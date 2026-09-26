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

export const JSON_ELEMENT: KtTypeUse = {
  text: "JsonElement",
  imports: ["kotlinx.serialization.json.JsonElement"],
  nullable: false,
};

export function scalarTypeUse(name: string): KtTypeUse {
  const [text, fqn] = SCALARS[name] ?? ["String"];
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
