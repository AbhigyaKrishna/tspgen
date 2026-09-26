import { getNamespaceFullName, getTypeName, type Type } from "@typespec/compiler";
import type { DecoratorData } from "./types.js";

/** Collect non-TypeSpec decorator applications as plain JSON-like data. */
export function collectDecorators(type: Type): DecoratorData {
  if (!("decorators" in type)) return {};
  const data: DecoratorData = {};
  for (const app of type.decorators) {
    const def = app.definition;
    if (!def) continue;
    const ns = getNamespaceFullName(def.namespace);
    if (ns === "TypeSpec" || ns.startsWith("TypeSpec.")) continue;
    const name = def.name.replace(/^@/, "");
    const key = ns ? `${ns}.${name}` : name;
    (data[key] ??= []).unshift(app.args.map((arg) => toPlain(arg.jsValue)));
  }
  return data;
}

function toPlain(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map(toPlain);
  if (typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown> & { asNumber?: () => number | null };
  if (typeof obj.asNumber === "function") return obj.asNumber();
  if (obj.entityKind === "Type") return typeToPlain(value as Type);
  if (obj.entityKind === "Value") return { valueKind: obj.valueKind };
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, toPlain(v)]));
}

function typeToPlain(type: Type): unknown {
  switch (type.kind) {
    case "String":
    case "Number":
    case "Boolean":
      return type.value;
    default:
      return { type: getTypeName(type) };
  }
}

/** First argument of the last application of `key`, if it is a string. */
export function decoratorArg(data: DecoratorData | undefined, key: string): string | undefined {
  const apps = data?.[key];
  const value = apps?.[apps.length - 1]?.[0];
  return typeof value === "string" ? value : undefined;
}

/** First argument of every application of `key` that is a string. */
export function decoratorArgs(data: DecoratorData | undefined, key: string): string[] {
  return (data?.[key] ?? []).map((args) => args[0]).filter((v): v is string => typeof v === "string");
}
