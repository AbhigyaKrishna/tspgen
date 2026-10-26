import { $ } from "@typespec/compiler/typekit";
import { isArrayModelType, resolveEncodedName, serializeValueAsJson, type Model, type ModelProperty, type Program, type Type, type Value } from "@typespec/compiler";

/** An exact numeric default that cannot cross a JavaScript number without losing its value. */
export class ExactNumericDefault {
  constructor(readonly text: string) {}
}

/** Kotlin constructors need logical scalar values and exact numbers, including nested defaults. */
export function collectDefault(program: Program, value: Value, type: Type): unknown {
  if (type.kind === "ModelProperty") return collectDefault(program, value, type.type);
  if (value.valueKind === "NumericValue") return value.value.asNumber() ?? new ExactNumericDefault(value.value.toString());
  if (value.valueKind === "EnumValue" && typeof value.value.value === "number") {
    let member = value.value;
    while (member.sourceMember) member = member.sourceMember;
    if (member.node?.value) {
      const literal = program.checker.getTypeForNode(member.node.value);
      if (literal.kind === "Number") return literal.numericValue.asNumber() ?? new ExactNumericDefault(literal.numericValue.toString());
    }
  }
  if (value.valueKind === "ArrayValue") {
    return value.values.map((item, index) => collectDefault(program, item,
      type.kind === "Model" && isArrayModelType(type) ? type.indexer.value
        : type.kind === "Tuple" ? type.values[index] : $(program).intrinsic.any));
  }
  if (value.valueKind === "ObjectValue") {
    const target = defaultType(program, value, type);
    return Object.fromEntries([...value.properties].map(([name, property]) => {
      const definition = target.kind === "Model" ? modelProperty(target, name) : undefined;
      const key = definition ? resolveEncodedName(program, definition, "application/json") : name;
      const propertyType = definition?.type ?? (target.kind === "Model" ? target.indexer?.value : undefined) ?? $(program).intrinsic.any;
      return [key, collectDefault(program, property.value, propertyType)];
    }));
  }
  if (value.valueKind === "ScalarValue" && value.value.name === "fromISO") {
    return collectDefault(program, value.value.args[0], $(program).intrinsic.any);
  }
  return serializeValueAsJson(program, value, type);
}

function defaultType(program: Program, value: Value, type: Type): Type {
  if (type.kind !== "Union") return type;
  const exact = program.checker.getValueExactType(value) ?? value.type;
  for (const variant of type.variants.values()) {
    if ($(program).type.isAssignableTo(exact, variant.type, value)) return defaultType(program, value, variant.type);
  }
  return type;
}

function modelProperty(model: Model, name: string): ModelProperty | undefined {
  for (let current: Model | undefined = model; current; current = current.baseModel) {
    const property = current.properties.get(name);
    if (property) return property;
  }
  return undefined;
}
