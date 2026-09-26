import { kotlinString } from "./kotlin-string.js";
import { needsSerialName } from "./serialization/kotlinx.js";
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
  /** How to reference `fqn` in a file: simple name unless it had to be qualified. */
  ref(fqn: string, qualified: readonly string[] = []): string {
    return qualified.includes(fqn) ? fqn : fqn.slice(fqn.lastIndexOf(".") + 1);
  },
  /** Constructor fields of a result variant: status (when not fixed), body, headers. */
  resultFields(v: KtResultVariant): string[] {
    return [
      ...(v.status === undefined ? ["val status: Int"] : []),
      ...(v.body ? [`val body: ${v.body.text}`] : []),
      ...v.headers.map((h) => `val ${h.name}: ${h.type.text}`),
    ];
  },
  /** Prefix every non-empty line with `pad`. */
  indent(text: string, pad: string): string {
    return text
      .split("\n")
      .map((line) => (line ? pad + line : line))
      .join("\n");
  },
  /** ` { init { … } }` for a data class with checks; "" when there are none. */
  initBlock(checks: readonly string[] = []): string {
    if (checks.length === 0) return "";
    return ` {\n    init {\n${checks.map((c) => `        ${c}\n`).join("")}    }\n}`;
  },
  needsSerialName,
  str: kotlinString,
};
