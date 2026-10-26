import type { ConstraintsIR, NumericBound } from "@abhigyakrishna/tspgen-core";
import { qualifyText } from "../imports.js";
import { kotlinString } from "../kotlin-string.js";
import type { KtTypeUse } from "./model.js";

const BOUNDS: [NumericBound, string, string][] = [
  ["minValue", ">=", "at least"], ["maxValue", "<=", "at most"],
  ["minValueExclusive", ">", "greater than"], ["maxValueExclusive", "<", "less than"],
];
const NUMERIC = new Set(["Byte", "Short", "Int", "Long", "ULong", "Float", "Double", "BigInteger", "BigDecimal", "String"]);

export interface BoundCheck { condition: string; message: string }

/** Generate exact comparisons without routing large bounds through a JavaScript number or Kotlin literal. */
export function boundChecks(expression: string, label: string, constraints: ConstraintsIR, type: KtTypeUse): BoundCheck[] {
  const qualified = qualifyText(type.text.replace(/\?$/, ""), type.imports);
  const simple = qualified.split(".").at(-1)!;
  const checks: BoundCheck[] = [];
  for (const [key, operator, message] of BOUNDS) {
    const temporal = constraints.scalarBounds?.[key];
    if (temporal !== undefined) {
      const pair = temporalExpressions(expression, temporal, qualified);
      if (pair) checks.push({ condition: `${pair[0]} ${operator} ${pair[1]}`, message: `${label} must be ${message} ${temporal}` });
      continue;
    }
    const value = constraints.numericBounds?.[key] ?? constraints[key];
    if (value === undefined || !NUMERIC.has(simple)) continue;
    if (simple === "ULong" && key === "minValue" && Number(value) <= 0) continue;
    const pair = numericExpressions(expression, value, simple, type.text.replace(/\?$/, ""));
    checks.push({ condition: `${pair[0]} ${operator} ${pair[1]}`, message: `${label} must be ${message} ${value}` });
  }
  return checks;
}

function numericExpressions(expression: string, value: number | string, simple: string, type: string): [string, string] {
  const text = String(value);
  if (simple === "BigDecimal" || simple === "BigInteger" && /^-?\d+$/.test(text)) {
    return [expression, `${type}(${kotlinString(text)})`];
  }
  const tooLarge = /^-?\d+$/.test(text) && (BigInt(text) < -(1n << 63n) || BigInt(text) >= (1n << 63n));
  if (typeof value === "string" || simple === "String" || simple === "BigInteger" || tooLarge || simple === "ULong" && Number(value) < 0) {
    return [`java.math.BigDecimal(${expression}.toString())`, `java.math.BigDecimal(${kotlinString(text)})`];
  }
  return [expression, simple === "ULong" ? `${text}uL` : text];
}

function temporalExpressions(expression: string, value: string, type: string): [string, string] | undefined {
  const literal = kotlinString(value);
  if (type === "java.time.OffsetDateTime") return [`${expression}.toInstant()`, `java.time.OffsetDateTime.parse(${literal}).toInstant()`];
  if (type === "String" && /T.*[Z+-]/.test(value)) return [`java.time.OffsetDateTime.parse(${expression}).toInstant()`, `java.time.OffsetDateTime.parse(${literal}).toInstant()`];
  const types = ["java.time.Instant", "java.time.LocalDate", "java.time.LocalTime", "java.time.Duration",
    "kotlin.time.Instant", "kotlinx.datetime.LocalDate", "kotlinx.datetime.LocalTime"];
  if (types.includes(type)) return [expression, `${type}.parse(${literal})`];
  if (type === "kotlin.time.Duration") return [expression, `kotlin.time.Duration.parseIsoString(${literal})`];
  return undefined;
}
