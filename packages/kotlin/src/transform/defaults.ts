import type { ModelIR, PropertyIR, TypeIR, TypeRef } from "@abhigyakrishna/tspgen-core";
import { ExactNumericDefault } from "@abhigyakrishna/tspgen-core";
import { qualifyText } from "../imports.js";
import { kotlinString } from "../kotlin-string.js";
import { identifier, upperSnake } from "../naming.js";
import { decoratorArg } from "./decorators.js";
import type { KtDataClass, KtDecl, KtTypeUse } from "./model.js";
import { fqnTypeUse } from "./type-map.js";

export interface DefaultContext {
  declaration(id: string): KtDecl | undefined;
  source(id: string): TypeIR | undefined;
  typeUse(ref: TypeRef): KtTypeUse;
  propertyName(id: string, name: string): string;
  enumMemberName?(name: string): string;
  /** Presence runtime FQN when optional nullable properties use wrappers. */
  optionalValue?: string;
  strictOptionals?: boolean;
}

/** Render an already JSON-serialized TypeSpec default as a Kotlin value expression. */
export function renderDefault(value: unknown, ref: TypeRef, type: KtTypeUse, context: DefaultContext): string | undefined {
  return render(value, ref, type, context, false);
}

function render(value: unknown, ref: TypeRef, type: KtTypeUse, context: DefaultContext, qualified: boolean): string | undefined {
  if (value === null) {
    if (ref.kind === "nullable" || type.nullable) return "null";
    return ref.kind === "unknown" || (ref.kind === "literal" && ref.value === null)
      ? "kotlinx.serialization.json.JsonNull" : undefined;
  }
  if (ref.kind === "nullable") {
    return render(value, ref.of, { ...type, text: type.text.replace(/\?$/, ""), nullable: false }, context, qualified);
  }
  if (ref.kind === "unknown") return jsonDefault(value);
  if (ref.kind === "literal" && value !== ref.value && value !== ref.numericText &&
    !(value instanceof ExactNumericDefault && value.text === ref.numericText)) return undefined;
  if (ref.kind === "array") {
    if (!Array.isArray(value)) return undefined;
    const elementType = type.element ?? context.typeUse(ref.of);
    const elements = value.map((item) => render(item, ref.of, elementType, context, true));
    return sequence("listOf", "emptyList", elements);
  }
  if (ref.kind === "map") {
    if (!isObject(value)) return undefined;
    const valueType = type.value ?? context.typeUse(ref.of);
    const entries = Object.entries(value).map(([key, item]) => {
      const expression = render(item, ref.of, valueType, context, true);
      return expression === undefined ? undefined : `${kotlinString(key)} to ${expression}`;
    });
    return sequence("mapOf", "emptyMap", entries);
  }
  if (ref.kind === "named") return namedDefault(value, ref, type, context, qualified);
  if (type.underlying) {
    const inner = render(value, ref, type.underlying, context, true);
    if (inner === undefined) return undefined;
    return type.wrapper === "value-class" ? `${expressionType(type, qualified)}(${inner})` : inner;
  }
  return scalarDefault(value, ref, type, qualified);
}

function namedDefault(
  value: unknown, ref: Extract<TypeRef, { kind: "named" }>, type: KtTypeUse,
  context: DefaultContext, qualified: boolean,
): string | undefined {
  const declaration = context.declaration(ref.id);
  const source = context.source(ref.id);
  const name = expressionType(type, qualified);
  const baseName = type.text.replace(/\?$/, "").split("<")[0];
  const qualifiedName = expressionType(type, true).split("<")[0];
  if (declaration && baseName !== declaration.name && qualifiedName !== declaration.fqn) return undefined;
  if (declaration?.kind === "enum") {
    const member = declaration.members.find((item) => item.value === value ||
      (value instanceof ExactNumericDefault && item.numericText === value.text) ||
      (item.value === undefined && item.serialName === String(value)));
    return member ? `${name}.${member.name}` : undefined;
  }
  if (declaration?.kind === "data-class" && source?.kind === "model") {
    return modelDefault(value, ref, type, declaration, source, context, qualified);
  }
  if (declaration?.kind === "untagged-union" && source?.kind === "union") {
    const candidates = source.variants.flatMap((variant, index) => {
      const target = declaration.variants[index];
      const expression = render(value, variant.type, target.type, context, true);
      return expression === undefined ? [] : [`${name}.${target.name}(${expression})`];
    });
    return candidates.length === 1 ? candidates[0] : undefined;
  }
  if (declaration?.kind === "sealed-interface" && source?.kind === "union") {
    const candidates = source.variants.flatMap((variant) => {
      const expression = render(value, variant.type, context.typeUse(variant.type), context, true);
      return expression === undefined ? [] : [expression];
    });
    return candidates.length === 1 ? candidates[0] : undefined;
  }
  if (declaration?.kind === "sealed-interface" && source?.kind === "model" && source.discriminator && isObject(value)) {
    const id = source.discriminator.mapping[String(value[source.discriminator.property])];
    return id ? render(value, { kind: "named", id }, context.typeUse({ kind: "named", id }), context, true) : undefined;
  }
  if (declaration?.kind === "value-class") {
    const inner = scalarDefault(value, { kind: "scalar", name: "string" }, declaration.value, true);
    return inner === undefined ? undefined : `${name}(${inner})`;
  }
  if (declaration?.kind === "typealias") {
    if (declaration.target.text === "JsonElement") return jsonDefault(value);
    return scalarDefault(value, ref, declaration.target, qualified);
  }
  if (!declaration && source?.kind === "enum") {
    const member = source.members.find((item) => item.value === value);
    if (!member) return undefined;
    const memberName = decoratorArg(member.decorators, "Kotlin.name") ??
      (context.enumMemberName ?? upperSnake)(member.name);
    return `${name}.${identifier(memberName)}`;
  }
  return undefined;
}

function modelDefault(
  value: unknown, ref: Extract<TypeRef, { kind: "named" }>, type: KtTypeUse,
  declaration: KtDataClass, source: ModelIR, context: DefaultContext, qualified: boolean,
): string | undefined {
  const properties = modelProperties(source, context);
  const isTuple = "tuple" in source && source.tuple === true;
  if (isTuple && (!Array.isArray(value) || value.length !== properties.length)) return undefined;
  if (!isTuple && !isObject(value)) return undefined;
  const supplied = isTuple
    ? Object.fromEntries(properties.map(({ property }, index) => [property.wireName, (value as unknown[])[index]]))
    : value as Record<string, unknown>;
  const parameters = new Map((source.typeParameters ?? []).map((name, index) => [name, ref.args?.[index]]));
  const expressions: string[] = [];
  for (const { owner, property } of properties) {
    if (declaration.discriminator === property.wireName) {
      if (property.type.kind === "literal" && Object.hasOwn(supplied, property.wireName) && supplied[property.wireName] !== property.type.value) return undefined;
      continue;
    }
    if (!Object.hasOwn(supplied, property.wireName)) {
      if (!property.optional && property.default === undefined) return undefined;
      continue;
    }
    const propertyRef = substitute(property.type, parameters);
    const override = decoratorArg(property.decorators, "Kotlin.type");
    const propertyType = override ? fqnTypeUse(override) : context.typeUse(propertyRef);
    let expression = render(supplied[property.wireName], propertyRef, propertyType, context, true);
    if (expression === undefined) return undefined;
    const presence = context.optionalValue && property.optional && (context.strictOptionals || propertyRef.kind === "nullable") && !declaration.plain;
    if (presence) expression = `${context.optionalValue}.Present(${expression})`;
    expressions.push(`${context.propertyName(owner, property.name)} = ${expression}`);
  }
  const knownKeys = new Set([...properties.map(({ property }) => property.wireName), declaration.discriminator]);
  const extras = Object.fromEntries(Object.entries(supplied).filter(([key]) => !knownKeys.has(key)));
  if (Object.keys(extras).length) {
    const extraSource = propertiesSource(source, context);
    if (!declaration.additional || !extraSource?.additionalProperties) return undefined;
    const extraRef: TypeRef = { kind: "map", of: substitute(extraSource.additionalProperties, parameters) };
    const expression = render(extras, extraRef, declaration.additional.type, context, true);
    if (expression === undefined) return undefined;
    expressions.push(`${declaration.additional.name} = ${expression}`);
  }
  return `${expressionType(type, qualified)}(${expressions.join(", ")})`;
}

function modelProperties(source: ModelIR, context: DefaultContext): { owner: string; property: PropertyIR }[] {
  const properties = new Map<string, { owner: string; property: PropertyIR }>();
  if (source.baseId) {
    const base = context.source(source.baseId);
    if (base?.kind === "model") {
      for (const item of modelProperties(base, context)) properties.set(item.property.name, item);
    }
  }
  for (const property of source.properties) properties.set(property.name, { owner: source.id, property });
  return [...properties.values()];
}

function propertiesSource(source: ModelIR, context: DefaultContext): ModelIR | undefined {
  if (source.additionalProperties) return source;
  const base = source.baseId ? context.source(source.baseId) : undefined;
  return base?.kind === "model" ? propertiesSource(base, context) : undefined;
}

function substitute(ref: TypeRef, parameters: Map<string, TypeRef | undefined>): TypeRef {
  if (ref.kind === "typeParam") return parameters.get(ref.name) ?? ref;
  if (ref.kind === "array" || ref.kind === "map" || ref.kind === "nullable") {
    return { ...ref, of: substitute(ref.of, parameters) };
  }
  if (ref.kind === "named" && ref.args) return { ...ref, args: ref.args.map((arg) => substitute(arg, parameters)) };
  return ref;
}

function scalarDefault(value: unknown, ref: TypeRef, type: KtTypeUse, qualified: boolean): string | undefined {
  const name = expressionType(type, qualified);
  const simple = type.text.replace(/\?$/, "").split(".").at(-1);
  if (simple === "String") {
    if (typeof value === "string") return kotlinString(value);
    if (value instanceof ExactNumericDefault && ref.kind === "scalar" && ref.name.startsWith("decimal")) return kotlinString(value.text);
    return ref.kind === "scalar" && (ref.name.startsWith("decimal") || ref.encoding === "string")
      && typeof value === "number" && Number.isFinite(value) ? kotlinString(String(value)) : undefined;
  }
  if (simple === "Boolean") return typeof value === "boolean" ? String(value) : undefined;
  if (typeof value === "string") {
    const date = dateDefault(value, type);
    if (date) return date;
  }
  const numeric = value instanceof ExactNumericDefault ? value.text
    : typeof value === "number" && Number.isFinite(value) ? String(value)
    : typeof value === "string" && /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) ? value : undefined;
  if (numeric === undefined) return undefined;
  if (simple === "BigDecimal" || simple === "BigInteger") return `${name}(${kotlinString(numeric)})`;
  if (simple === "Float") return `${numeric}f`;
  if (simple === "Double") return Number.isInteger(Number(numeric)) && !/[.eE]/.test(numeric) ? `${numeric}.0` : numeric;
  if (!/^-?\d+$/.test(numeric)) return undefined;
  if (simple === "Long") {
    if (BigInt(numeric) === -(1n << 63n)) return "Long.MIN_VALUE";
    return BigInt(numeric) >= -(1n << 63n) && BigInt(numeric) < (1n << 63n) ? `${numeric}L` : undefined;
  }
  if (simple === "ULong") return BigInt(numeric) >= 0 && BigInt(numeric) < (1n << 64n) ? `${numeric}uL` : undefined;
  return simple === "Int" || simple === "Short" || simple === "Byte" ? numeric : undefined;
}

function dateDefault(value: string, type: KtTypeUse): string | undefined {
  const name = expressionType(type, true);
  const dateTypes = ["java.time.Instant", "java.time.OffsetDateTime", "java.time.LocalDate", "java.time.LocalTime",
    "java.time.Duration", "kotlin.time.Instant", "kotlinx.datetime.LocalDate", "kotlinx.datetime.LocalTime"];
  if (dateTypes.includes(name)) return `${name}.parse(${kotlinString(value)})`;
  return name === "kotlin.time.Duration" ? `${name}.parseIsoString(${kotlinString(value)})` : undefined;
}

function expressionType(type: KtTypeUse, qualified: boolean): string {
  const text = type.text.replace(/\?$/, "");
  return qualified ? qualifyText(text, type.imports) : text;
}

function sequence(constructor: string, empty: string, values: (string | undefined)[]): string | undefined {
  if (values.some((value) => value === undefined)) return undefined;
  return values.length ? `${constructor}(${values.join(", ")})` : `${empty}()`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonDefault(value: unknown): string | undefined {
  const json = defaultJson(value);
  return json === undefined ? undefined : `kotlinx.serialization.json.Json.parseToJsonElement(${kotlinString(json)})`;
}

function defaultJson(value: unknown): string | undefined {
  if (value instanceof ExactNumericDefault) return value.text;
  if (Array.isArray(value)) return `[${value.map(defaultJson).join(",")}]`;
  if (isObject(value)) return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}:${defaultJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
