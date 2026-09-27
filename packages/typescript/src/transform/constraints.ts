import type { ConstraintsIR } from "@abhigyakrishna/tspgen-core";
import type { TsTypeUse } from "./model.js";

const NULLABLE = ".nullable()";

/**
 * Appends zod refinements for TypeSpec constraint decorators (and the `notBlank` meta flag) to a string,
 * number or array schema, before any `.nullable()`. Constraints that don't fit the base schema are ignored,
 * as in the Kotlin emitter; only `schema` changes. A `@pattern` is compiled with the `u` flag when valid
 * there, else without flags; one JavaScript can't parse at all is skipped and passed to `onInvalidPattern`.
 */
export function constrain(
  type: TsTypeUse,
  c: ConstraintsIR | undefined,
  notBlank = false,
  onInvalidPattern?: (pattern: string) => void,
): TsTypeUse {
  if (!c && !notBlank) return type;
  const isNullable = type.schema.endsWith(NULLABLE);
  const base = isNullable ? type.schema.slice(0, -NULLABLE.length) : type.schema;
  const rules = refinements(base, c ?? {}, notBlank, onInvalidPattern);
  if (rules.length === 0) return type;
  return { ...type, schema: `${base}${rules.join("")}${isNullable ? NULLABLE : ""}` };
}

function refinements(
  base: string,
  c: ConstraintsIR,
  notBlank: boolean,
  onInvalidPattern: ((pattern: string) => void) | undefined,
): string[] {
  const rules: string[] = [];
  const add = (method: string, value: number | undefined) => {
    if (value !== undefined) rules.push(`.${method}(${value})`);
  };
  if (base === "z.string()") {
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
