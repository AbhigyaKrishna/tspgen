import type { ApiIR, ConstraintsIR, TypeRef } from "@abhigyakrishna/tspgen-core";

/** Compact recursive nullability description consumed by the generated runtime. */
export function nullShape(ref: TypeRef, api?: ApiIR): string {
  switch (ref.kind) {
    case "nullable": return `?${nullShape(ref.of, api)}`;
    case "array": return `a${nullShape(ref.of, api)}`;
    case "map": return `m${nullShape(ref.of, api)}`;
    case "typeParam": return `t${ref.name}`;
    case "unknown": return "?_";
    case "scalar": return ref.name === "integer" ? "i" : "_";
    case "named": {
      const model = api?.types.find((type) => type.id === ref.id);
      const args = ref.args;
      if (model?.kind !== "model" || !model.typeParameters?.length || !args) return "_";
      const argumentsByName = Object.fromEntries(model.typeParameters.map((name, index) => [
        name, nullShape(args[index], api),
      ]));
      return `g${JSON.stringify(argumentsByName)}`;
    }
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
  api?: ApiIR,
): GoPropertyCheck {
  return { name, value, optional, shape: nullShape(ref, api), constraints: constraintsLiteral(constraints, ref, qualifier) };
}

export function propertyCheckCall(check: GoPropertyCheck, qualifier = "models."): string {
  return `${qualifier}CheckProperty(${JSON.stringify(check.name)}, ${check.value}, ${check.optional}, ${JSON.stringify(check.shape)}, ${check.constraints})`;
}
