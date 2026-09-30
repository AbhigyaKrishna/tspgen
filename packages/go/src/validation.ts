import type { ConstraintsIR, TypeRef } from "@abhigyakrishna/tspgen-core";

/** Compact recursive nullability description consumed by the generated runtime. */
export function nullShape(ref: TypeRef): string {
  switch (ref.kind) {
    case "nullable": return `?${nullShape(ref.of)}`;
    case "array": return `a${nullShape(ref.of)}`;
    case "map": return `m${nullShape(ref.of)}`;
    case "unknown":
    case "typeParam": return "?_";
    default: return "_";
  }
}

export function constraintsLiteral(
  constraints: ConstraintsIR = {},
  ref?: TypeRef,
  qualifier = "models.",
): string {
  const fields = {
    MinLength: constraints.minLength ?? -1,
    MaxLength: constraints.maxLength ?? -1,
    MinItems: constraints.minItems ?? -1,
    MaxItems: constraints.maxItems ?? -1,
    MinValue: constraints.minValue === undefined ? "" : String(constraints.minValue),
    MaxValue: constraints.maxValue === undefined ? "" : String(constraints.maxValue),
    Pattern: constraints.pattern ?? "",
    Literal: ref?.kind === "literal" ? JSON.stringify(ref.value) : "",
  };
  const entries = Object.entries(fields).map(([name, value]) => `${name}: ${JSON.stringify(value)}`);
  return `${qualifier}PropertyConstraints{${entries.join(", ")}}`;
}

export interface GoPropertyCheck {
  name: string;
  value: string;
  optional: boolean;
  shape: string;
  constraints: string;
}

export function propertyCheck(
  name: string,
  value: string,
  optional: boolean,
  ref: TypeRef,
  constraints?: ConstraintsIR,
  qualifier = "models.",
): GoPropertyCheck {
  return { name, value, optional, shape: nullShape(ref), constraints: constraintsLiteral(constraints, ref, qualifier) };
}

export function propertyCheckCall(check: GoPropertyCheck, qualifier = "models."): string {
  return `${qualifier}CheckProperty(${JSON.stringify(check.name)}, ${check.value}, ${check.optional}, ${JSON.stringify(check.shape)}, ${check.constraints})`;
}
