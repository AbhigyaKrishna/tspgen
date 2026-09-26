import { NoTarget, type Program } from "@typespec/compiler";
import type { DecoratorData } from "./ir/types.js";
import { reportDiagnostic } from "./lib.js";

export type MetaData = Record<string, unknown>;
/** Metadata by scope: "*", "<language>", "<language>:<target>". */
export type MetaScopes = Record<string, MetaData>;

export const META_DECORATOR = "TspGen.meta";

function isObject(value: unknown): value is MetaData {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Key-by-key merge; `b` wins, except arrays on both sides are concatenated. */
export function mergeMeta(a: MetaData, b: MetaData): MetaData {
  const out: MetaData = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const current = out[key];
    out[key] = Array.isArray(current) && Array.isArray(value) ? [...current, ...value] : value;
  }
  return out;
}

export function mergeScopes(a: MetaScopes, b: MetaScopes): MetaScopes {
  const out: MetaScopes = { ...a };
  for (const [scope, data] of Object.entries(b)) out[scope] = mergeMeta(out[scope] ?? {}, data);
  return out;
}

/** Metadata scopes from `@TspGen.meta` applications (in source order). */
export function metaScopes(decorators: DecoratorData | undefined): MetaScopes {
  const scopes: MetaScopes = {};
  for (const [scope, data] of decorators?.[META_DECORATOR] ?? []) {
    if (typeof scope !== "string" || !isObject(data)) continue;
    scopes[scope] = mergeMeta(scopes[scope] ?? {}, data);
  }
  return scopes;
}

/** Effective metadata for a language (and optionally one of its targets): "*" → language → language:target. */
export function resolveMeta(scopes: MetaScopes | undefined, language: string, target?: string): MetaData {
  const order = ["*", language, ...(target ? [`${language}:${target}`] : [])];
  return order.reduce<MetaData>((acc, scope) => mergeMeta(acc, scopes?.[scope] ?? {}), {});
}

function invalid(program: Program, key: string, where: string, expected: string): undefined {
  reportDiagnostic(program, { code: "invalid-meta", format: { key, where, expected }, target: NoTarget });
  return undefined;
}

/** A string or list of strings; [] when absent or invalid. */
export function metaStrings(program: Program, meta: MetaData, key: string, where: string): string[] {
  const value = meta[key];
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
  invalid(program, key, where, "a string or a list of strings");
  return [];
}

export function metaBoolean(program: Program, meta: MetaData, key: string, where: string): boolean | undefined {
  const value = meta[key];
  if (value === undefined || typeof value === "boolean") return value;
  return invalid(program, key, where, "a boolean");
}

export function metaNumber(program: Program, meta: MetaData, key: string, where: string): number | undefined {
  const value = meta[key];
  if (value === undefined || typeof value === "number") return value;
  return invalid(program, key, where, "a number");
}

export function metaObject(program: Program, meta: MetaData, key: string, where: string): MetaData | undefined {
  const value = meta[key];
  if (value === undefined || isObject(value)) return value;
  return invalid(program, key, where, "an object");
}

/** A list of objects; [] when absent or invalid. */
export function metaObjects(program: Program, meta: MetaData, key: string, where: string): MetaData[] {
  const value = meta[key];
  if (value === undefined) return [];
  if (Array.isArray(value) && value.every(isObject)) return value;
  invalid(program, key, where, "a list of objects");
  return [];
}
