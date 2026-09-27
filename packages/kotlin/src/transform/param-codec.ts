import type { KtTypeUse } from "./model.js";
import { javaTimeCodec } from "./type-map.js";

/** Parse calls of primitive parameter types, applied to the wire string. */
const PARSE: Record<string, string> = {
  Int: "toInt()",
  Long: "toLong()",
  ULong: "toULong()",
  Short: "toShort()",
  Byte: "toByte()",
  Double: "toDouble()",
  Float: "toFloat()",
  Boolean: "toBooleanStrict()",
  BigDecimal: "toBigDecimal()",
  "java.math.BigDecimal": "toBigDecimal()",
};

/** `type` without its `?`. */
export function bareType(type: KtTypeUse): KtTypeUse {
  return type.nullable ? { ...type, text: type.text.replace(/\?$/, ""), nullable: false } : type;
}

/**
 * Imports a `paramDecode`/`paramEncode` call on `type` needs: its own imports plus its `underlying`'s (recursively —
 * a typealias/value-class scalar's decode expression names the underlying type directly, e.g. `Instant.parse(it)`
 * or `Seen(Instant.parse(it))`, which the wrapper's own imports alone (`Seen`'s fqn) do not cover).
 */
export function codecImports(type: KtTypeUse): string[] {
  return type.underlying ? [...type.imports, ...codecImports(type.underlying)] : type.imports;
}

/** Element of a `List` parameter type (from `listOf`, else read from the text); undefined for other types. */
export function listElement(type: KtTypeUse): KtTypeUse | undefined {
  const bare = bareType(type);
  if (bare.element) return bare.element;
  const text = /^List<(.+)>$/.exec(bare.text)?.[1];
  return text ? { text, imports: bare.imports, nullable: false } : undefined;
}

/**
 * Kotlin expression parsing the wire string `expr` into `type` (its `?` ignored): as-is for strings, `X.parse` for
 * java.time, `toInt()`-style calls for primitives, `decodeParam<T>` (kotlinx, ServerSupport/ClientSupport) otherwise.
 */
export function paramDecode(expr: string, type: KtTypeUse): string {
  const t = bareType(type);
  if (t.underlying) {
    const inner = paramDecode(expr, t.underlying);
    return t.wrapper === "value-class" ? `${t.text}(${inner})` : inner;
  }
  if (t.text === "String") return expr;
  if (javaTimeCodec(t.text, t.imports)) return `${t.text}.parse(${expr})`;
  const parse = PARSE[t.text];
  return parse ? `${expr}.${parse}` : `decodeParam<${t.text}>(${expr})`;
}

/** Kotlin expression writing the non-null value `expr` of `type` as its wire string. */
export function paramEncode(expr: string, type: KtTypeUse): string {
  const t = bareType(type);
  if (t.underlying) return paramEncode(t.wrapper === "value-class" ? `${expr}.value` : expr, t.underlying);
  if (t.text === "String") return expr;
  if (t.text === "BigDecimal" || t.text === "java.math.BigDecimal") return `${expr}.toPlainString()`;
  if (javaTimeCodec(t.text, t.imports) || PARSE[t.text]) return `${expr}.toString()`;
  return `encodeParam(${expr})`;
}
