import { lineComments } from "@abhigyakrishna/tspgen-core";
import type { TsEnum, TsResultVariant } from "./transform/model.js";

/** Helpers exposed to templates as `it.h`. */
export const tsHelpers = {
  /** `text` as `//` line comments (header text). */
  lineComment(text: string): string {
    return lineComments(text, "//");
  },
  /** JSDoc block (with trailing newline) or "" when there is nothing to document. */
  jsdoc(docs?: string, indent = "", deprecated?: string, defaultDoc?: string, extra: readonly string[] = []): string {
    const lines = [
      ...(docs ? docs.replace(/\*\//g, "* /").split("\n") : []),
      ...(deprecated ? [`@deprecated ${deprecated}`] : []),
      ...(defaultDoc !== undefined ? [`@default ${defaultDoc}`] : []),
      ...extra,
    ];
    if (lines.length === 0) return "";
    return `${indent}/**\n${lines.map((l) => `${indent} *${l ? ` ${l}` : ""}`).join("\n")}\n${indent} */\n`;
  },
  literal(value: string | number | boolean): string {
    return typeof value === "string" ? JSON.stringify(value) : String(value);
  },
  str(value: string): string {
    return JSON.stringify(value);
  },
  /** `// ── Title ───…` padded to 80 columns (including `indent`). */
  banner(title: string, indent = ""): string {
    const head = `${indent}// ── ${title} `;
    return head + "─".repeat(Math.max(3, 80 - head.length));
  },
  /** The enum's type declaration: a literal union, or a const tuple plus derived type when `values` is set. */
  enumType(d: TsEnum): string {
    const literals = d.members.map((m) => (typeof m.value === "string" ? JSON.stringify(m.value) : String(m.value)));
    return d.values
      ? `export const ${d.values} = [${literals.join(", ")}] as const;\n\nexport type ${d.name} = (typeof ${d.values})[number];`
      : `export type ${d.name} = ${literals.join(" | ")};`;
  },
  /** `{ status: 201; body: Pet; headers: { location: string } }` */
  resultVariant(v: TsResultVariant): string {
    const fields = [`status: ${v.status ?? "number"}`];
    if (v.body) fields.push(`body: ${v.body.text}`);
    if (v.headers.length > 0) {
      fields.push(`headers: { ${v.headers.map((h) => `${h.name}${h.optional ? "?" : ""}: ${h.type.text}`).join("; ")} }`);
    }
    return `{ ${fields.join("; ")} }`;
  },
};
