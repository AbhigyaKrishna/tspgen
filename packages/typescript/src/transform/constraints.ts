import type { ConstraintsIR } from "@abhigyakrishna/tspgen-core";
import type { TsTypeUse } from "./model.js";
import { DECIMAL_STRING, INTEGER_STRING, UNSIGNED_INTEGER_STRING } from "./type-map.js";

const NULLABLE = ".nullable()";

/**
 * Appends zod refinements for TypeSpec constraint decorators (and the `notBlank` meta flag) to a string,
 * number or array schema, before any `.nullable()`. Constraints that don't fit the base schema are ignored,
 * as in the Kotlin emitter; only `schema` changes. A `@pattern` is compiled with the `u` flag when valid
 * there, else without flags; one JavaScript can't parse at all is skipped and passed to `onInvalidPattern`.
 * `@minValue`/`@maxValue` on an `@encode(string)` integer (base `INTEGER_STRING`/`UNSIGNED_INTEGER_STRING`) are
 * checked with a `BigInt`-comparing `.refine()` (the value can exceed `Number`'s safe range). The same on a
 * decimal (base `DECIMAL_STRING`, always a string) can't be checked losslessly this way — `onUnsupportedBounds`
 * is called instead so the caller can warn that the bound has no effect.
 */
export function constrain(
  type: TsTypeUse,
  c: ConstraintsIR | undefined,
  notBlank = false,
  onInvalidPattern?: (pattern: string) => void,
  onUnsupportedBounds?: () => void,
): TsTypeUse {
  if (!c && !notBlank) return type;
  const isNullable = type.schema.endsWith(NULLABLE);
  const base = isNullable ? type.schema.slice(0, -NULLABLE.length) : type.schema;
  const rules = refinements(base, c ?? {}, notBlank, onInvalidPattern, onUnsupportedBounds);
  if (rules.length === 0) return type;
  return { ...type, schema: `${base}${rules.join("")}${isNullable ? NULLABLE : ""}` };
}

function refinements(
  base: string,
  c: ConstraintsIR,
  notBlank: boolean,
  onInvalidPattern: ((pattern: string) => void) | undefined,
  onUnsupportedBounds: (() => void) | undefined,
): string[] {
  const rules: string[] = [];
  const add = (method: string, value: number | undefined) => {
    if (value !== undefined) rules.push(`.${method}(${value})`);
  };
  if (base.startsWith("z.string()")) {
    if (base === INTEGER_STRING || base === UNSIGNED_INTEGER_STRING) {
      if (c.minValue !== undefined) rules.push(bigintBound(">=", c.minValue));
      if (c.maxValue !== undefined) rules.push(bigintBound("<=", c.maxValue));
    } else if (base === DECIMAL_STRING && (c.minValue !== undefined || c.maxValue !== undefined)) {
      onUnsupportedBounds?.();
    }
    if (notBlank) rules.push(`.regex(/\\S/, "must not be blank")`);
    add("min", c.minLength);
    add("max", c.maxLength);
    if (c.pattern !== undefined) {
      const regex = regexExpression(c.pattern);
      if (regex) rules.push(`.regex(${regex})`);
      else onInvalidPattern?.(c.pattern);
    }
  } else if (base.startsWith("z.number()")) {
    add("gte", c.minValue);
    add("lte", c.maxValue);
  } else if (base.startsWith("z.array(")) {
    add("min", c.minItems);
    add("max", c.maxItems);
  }
  return rules;
}

/** `.refine((v) => BigInt(v) >= 1n)`: an exact-precision bound check for a base-10 integer sent as a string. */
function bigintBound(op: ">=" | "<=", value: number): string {
  return `.refine((v) => BigInt(v) ${op} ${BigInt(Math.trunc(value))}n)`;
}

/** `new RegExp(…)` source for a pattern: with the `u` flag when valid there, else without; undefined if invalid. */
function regexExpression(pattern: string): string | undefined {
  const source = JSON.stringify(pattern);
  if (compiles(pattern, "u")) return `new RegExp(${source}, "u")`;
  if (compiles(pattern, "")) return `new RegExp(${source})`;
  return undefined;
}

function compiles(pattern: string, flags: string): boolean {
  try {
    new RegExp(pattern, flags);
    return true;
  } catch {
    return false;
  }
}
