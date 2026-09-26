import { kotlinString } from "./kotlin-string.js";
import type { KtResultVariant } from "./transform/model.js";

/** Helpers exposed to templates as `it.h`. */
export const kotlinHelpers = {
  kdoc(docs: string | undefined, indent = ""): string {
    if (!docs) return "";
    const lines = docs.replace(/\*\//g, "* /").split("\n");
    return `${indent}/**\n${lines.map((l) => `${indent} *${l ? ` ${l}` : ""}`).join("\n")}\n${indent} */\n`;
  },
  annotations(list: readonly string[] = [], indent = ""): string {
    return list.map((a) => `${indent}${a}\n`).join("");
  },
  simpleName(fqn: string): string {
    return fqn.slice(fqn.lastIndexOf(".") + 1);
  },
  /** Constructor fields of a result variant: status (when not fixed), body, headers. */
  resultFields(v: KtResultVariant): string[] {
    return [
      ...(v.status === undefined ? ["val status: Int"] : []),
      ...(v.body ? [`val body: ${v.body.text}`] : []),
      ...v.headers.map((h) => `val ${h.name}: ${h.type.text}`),
    ];
  },
  str: kotlinString,
};
