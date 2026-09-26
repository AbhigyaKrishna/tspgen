import { pascal } from "@abhigyakrishna/tspgen-core";

export function typeName(value: string): string {
  const name = pascal(value);
  return /^[0-9]/.test(name) ? `T${name}` : name;
}

export function camel(value: string): string {
  const name = pascal(value).replace(/^[A-Z]+(?=[A-Z][a-z]|$)|^[A-Z]/, (m) => m.toLowerCase());
  return /^[0-9]/.test(name) ? `v${name}` : name;
}

/** Name for a key of an enum's const object. */
export function memberName(value: string): string {
  const name = pascal(value);
  return /^[0-9]/.test(name) ? `V${name}` : name || "Empty";
}

/** Object key as written in TS: bare when a valid identifier, otherwise a string literal. */
export function propertyKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}
