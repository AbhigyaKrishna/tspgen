import type { DecoratorData } from "@specgen/emitter-core";

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
