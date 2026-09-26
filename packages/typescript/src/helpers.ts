import type { TsResultVariant } from "./transform/model.js";

/** Helpers exposed to templates as `it.h`. */
export const tsHelpers = {
  /** JSDoc block (with trailing newline) or "" when there is nothing to document. */
  jsdoc(docs?: string, indent = "", deprecated?: string, defaultDoc?: string): string {
    const lines = [
      ...(docs ? docs.replace(/\*\//g, "* /").split("\n") : []),
      ...(deprecated ? [`@deprecated ${deprecated}`] : []),
      ...(defaultDoc !== undefined ? [`@default ${defaultDoc}`] : []),
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
