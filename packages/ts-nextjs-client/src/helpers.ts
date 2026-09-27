import type { StatusCodes } from "@abhigyakrishna/tspgen-core";
import type { TsGroup, TsHeader, TsOperation, TsResultVariant, TsTypeUse } from "@abhigyakrishna/tspgen-typescript";
import { names } from "./names.js";

export interface Field {
  key: string;
  type: TsTypeUse;
  optional: boolean;
  docs?: string;
}

const str = (value: string) => JSON.stringify(value);

function key(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : str(name);
}

function fields(op: TsOperation): Field[] {
  return [
    ...op.params.map((p) => ({ key: p.name, type: p.type, optional: p.optional, ...(p.docs ? { docs: p.docs } : {}) })),
    ...(op.body ? [{ key: op.body.name, type: op.body.type, optional: op.body.optional }] : []),
  ];
}

function isQuery(op: TsOperation): boolean {
  return op.verb === "get" || op.verb === "head";
}

function isJson(op: TsOperation): boolean {
  return !op.body || op.body.contentType.includes("json");
}

function parseExpr(type: TsTypeUse, zod: boolean): string {
  return zod ? `parse(this.config, res, ${type.schema})` : `parse<${type.text}>(this.config, res)`;
}

function headerExpr(h: TsHeader): string {
  const wire = str(h.wireName);
  const map = h.type.text === "number" ? "Number" : h.type.text === "boolean" ? `(value) => value === "true"` : "";
  if (h.optional) return `optionalHeader(res, ${wire}${map ? `, ${map}` : ""})`;
  const raw = `requireHeader(res, ${wire})`;
  return map === "Number" ? `Number(${raw})` : map ? `${raw} === "true"` : raw;
}

function statusCondition(codes: StatusCodes): string {
  if (codes === "default") return "res.ok";
  if (typeof codes === "number") return `res.status === ${codes}`;
  return `res.status >= ${codes.start} && res.status <= ${codes.end}`;
}

function variantExpr(v: TsResultVariant, zod: boolean): string {
  const parts = [`status: ${v.status ?? "res.status"}`];
  if (v.body) parts.push(`body: await ${parseExpr(v.body, zod)}`);
  // Optional headers are spread only when present so the object fits `name?: T` under exactOptionalPropertyTypes.
  const header = (h: TsHeader) => (h.optional ? `...optionalEntry(${str(h.name)}, ${headerExpr(h)})` : `${key(h.name)}: ${headerExpr(h)}`);
  if (v.headers.length > 0) parts.push(`headers: { ${v.headers.map(header).join(", ")} }`);
  return `{ ${parts.join(", ")} }`;
}

function errorKey(codes: StatusCodes): string {
  if (codes === "default") return "default";
  return typeof codes === "number" ? String(codes) : str(`${Math.floor(codes.start / 100)}XX`);
}

/** Exposed to templates as `it.h.nextjs`. */
export const nextjsHelpers = {
  names,
  fields,
  isQuery,
  isJson,
  key,

  hasParams(op: TsOperation): boolean {
    return fields(op).length > 0;
  },

  /** Params are optional when every field is optional. */
  paramsDecl(g: TsGroup, op: TsOperation): string {
    const f = fields(op);
    if (f.length === 0) return "";
    return f.every((x) => x.optional) ? `params: ${names.params(g, op)} = {}` : `params: ${names.params(g, op)}`;
  },

  signature(g: TsGroup, op: TsOperation): string {
    const params = nextjsHelpers.paramsDecl(g, op);
    return params ? `${params}, options?: RequestOptions` : "options?: RequestOptions";
  },

  pathExpr(op: TsOperation): string {
    let dynamic = false;
    const path = op.path.replace(/\{([^}]+)\}/g, (match, wire: string) => {
      const param = op.params.find((p) => p.location === "path" && p.wireName === wire);
      if (!param) return match;
      dynamic = true;
      return `\${encodeURIComponent(String(params.${param.name}))}`;
    });
    return dynamic ? `\`${path}\`` : str(path);
  },

  /** Extra `RequestSpec` properties (query, headers, cookies, body) as `key: value,` lines. */
  specLines(op: TsOperation): string[] {
    const lines: string[] = [];
    const query = op.params.filter((p) => p.location === "query");
    if (query.length > 0) {
      lines.push(`query: [${query.map((p) => `[${str(p.wireName)}, params.${p.name}, ${p.explode}]`).join(", ")}],`);
    }
    for (const [location, prop] of [["header", "headers"], ["cookie", "cookies"]] as const) {
      const list = op.params.filter((p) => p.location === location);
      if (list.length > 0) lines.push(`${prop}: { ${list.map((p) => `${key(p.wireName)}: params.${p.name}`).join(", ")} },`);
    }
    if (op.body) lines.push(`body: params.${op.body.name},`, `contentType: ${str(op.body.contentType)},`);
    return lines;
  },

  successLines(op: TsOperation, zod: boolean): string[] {
    const r = op.result;
    if (r.kind === "single") {
      return [r.type.text === "void" ? "if (res.ok) return;" : `if (res.ok) return ${parseExpr(r.type, zod)};`];
    }
    return r.decl.variants.map((v) => `if (${statusCondition(v.statusCodes)}) return ${variantExpr(v, zod)};`);
  },

  /** Third argument of request(): per-call options over @meta defaults. */
  optionsExpr(extras: { next?: Record<string, unknown> } | undefined): string {
    return extras?.next ? `{ next: ${JSON.stringify(extras.next)}, ...options }` : "options";
  },

  errorFactories(op: TsOperation): string[] {
    const rank = (c: StatusCodes) => (c === "default" ? 2 : typeof c === "number" ? 0 : 1);
    return [...op.errors]
      .sort((a, b) => rank(a.statusCodes) - rank(b.statusCodes))
      .map((e) =>
        e.body
          ? `${errorKey(e.statusCodes)}: (status, body) => new ${e.errorClass.text}(status, body as ${e.body.text})`
          : `${errorKey(e.statusCodes)}: (status, body) => new HttpError(status, body)`,
      );
  },
};
