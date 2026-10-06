import { isDefaultStatus, isFixedStatus, statusRank, type StatusCodes } from "@abhigyakrishna/tspgen-core";
import { propertyKey, type TsGroup, type TsHeader, type TsOperation, type TsParam, type TsPart, type TsResultVariant, type TsTypeUse } from "@abhigyakrishna/tspgen-typescript";
import { memberType } from "./auth.js";
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

/** No body or a JSON one; uploads (even a file body declared `application/json`) are not. */
function isJson(op: TsOperation): boolean {
  return !op.body || (!isUpload(op) && op.body.contentType.includes("json"));
}

/** A server-sent event stream: the method is an async generator of its events. */
function isStream(op: TsOperation): boolean {
  return op.result.kind === "single" && op.result.stream !== undefined;
}

/** Operations React Query hooks and Server Actions cover: JSON, not uploads nor streams. */
function isHookable(op: TsOperation): boolean {
  return isJson(op) && !isStream(op);
}

/**
 * Static event descriptors of a typed stream: `[{ event, data, literal?, value?, terminal? }, …]` (the runtime picks
 * the event by name, literal data first); undefined for an untyped stream.
 */
function eventsExpr(op: TsOperation): string {
  const events = op.result.kind === "single" ? op.result.stream?.events : undefined;
  if (!events) return "undefined";
  const items = events.map((e) => {
    const parts = [`event: ${str(e.event)}`, `data: ${str(e.data)}`];
    if (e.literal !== undefined) parts.push(`literal: ${str(e.literal)}`, `value: ${JSON.stringify(e.value)}`);
    if (e.terminal) parts.push("terminal: true");
    return `{ ${parts.join(", ")} }`;
  });
  return `[${items.join(", ")}]`;
}

/** Multipart and file bodies: sent by the request runtime as FormData / a Blob. */
function isUpload(op: TsOperation): boolean {
  return op.body?.kind === "multipart" || op.body?.kind === "file";
}

/**
 * Static multipart descriptor: `[{ name, key?, kind, multi, contentType? }, …]`; key only when it differs from the
 * part name; contentType for file parts that declare one (the first, bar `*\/*`) and for JSON parts declaring a JSON
 * media type other than application/json (the first).
 */
function partsExpr(parts: readonly TsPart[]): string {
  const items = parts.map((p) => {
    const contentType = partContentType(p);
    const key = p.key !== p.name ? `key: ${str(p.key)}, ` : "";
    return `{ name: ${str(p.name)}, ${key}kind: ${str(p.kind)}, multi: ${p.multi}${contentType ? `, contentType: ${str(contentType)}` : ""} }`;
  });
  return `[${items.join(", ")}]`;
}

function partContentType(part: TsPart): string | undefined {
  if (part.kind === "file") return part.contentTypes.find((t) => t !== "*/*");
  if (part.kind !== "json") return undefined;
  const json = part.contentTypes.find((t) => /[/+]json(;|$)/.test(t));
  return json === "application/json" ? undefined : json;
}

function parseExpr(type: TsTypeUse, zod: boolean): string {
  return zod ? `parse(this.config, res, ${type.schema}${type.codec ? ", true" : ""})` : `parse<${type.text}>(this.config, res)`;
}

function headerExpr(h: TsHeader): string {
  const wire = str(h.wireName);
  const map =
    h.type.text === "number"
      ? "Number"
      : h.type.text === "boolean"
        ? `(value) => value === "true"`
        : h.type.date
          ? "(value) => new Date(value)"
          : "";
  if (h.optional) return `optionalHeader(res, ${wire}${map ? `, ${map}` : ""})`;
  const raw = `requireHeader(res, ${wire})`;
  if (h.type.text === "number") return `Number(${raw})`;
  if (h.type.text === "boolean") return `${raw} === "true"`;
  if (h.type.date) return `new Date(${raw})`;
  return raw;
}

/** Whether an operation's params schema decodes (a `Date` field): Server Actions then check by encoding. */
function paramsCodec(op: TsOperation): boolean {
  return fields(op).some((f) => f.type.codec === true);
}

function statusCondition(codes: StatusCodes): string {
  if (isDefaultStatus(codes)) return "res.ok";
  if (isFixedStatus(codes)) return `res.status === ${codes}`;
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
  if (isDefaultStatus(codes)) return "default";
  return isFixedStatus(codes) ? String(codes) : str(`${Math.floor(codes.start / 100)}XX`);
}

/** Flat style: `{ kind?: Kind; limit?: number }`, the type of a method's query object (and of `<Op>Vars.query`). */
export function queryObjectType(query: readonly TsParam[]): string {
  return `{ ${query.map((p) => `${propertyKey(p.wireName)}${p.optional ? "?" : ""}: ${p.type.text}`).join("; ")} }`;
}

/** Exposed to templates as `it.h.nextjs`. */
export const nextjsHelpers = {
  names,
  fields,
  isQuery,
  isJson,
  isUpload,
  isStream,
  isHookable,
  eventsExpr,
  partsExpr,
  key,
  memberType,
  paramsCodec,

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
      const value = param.type.date ? `params.${param.name}.toISOString()` : `String(params.${param.name})`;
      return `\${encodeURIComponent(${value})}`;
    });
    return dynamic ? `\`${path}\`` : str(path);
  },

  /** Extra `RequestSpec` properties (query, headers, cookies, body, auth descriptor) as `key: value,` lines. */
  specLines(op: TsOperation, auth?: string): string[] {
    const lines: string[] = [];
    const query = op.params.filter((p) => p.location === "query");
    if (query.length > 0) {
      lines.push(`query: [${query.map((p) => `[${str(p.wireName)}, params.${p.name}, ${p.explode}]`).join(", ")}],`);
    }
    for (const [location, prop] of [["header", "headers"], ["cookie", "cookies"]] as const) {
      const list = op.params.filter((p) => p.location === location);
      if (list.length > 0) lines.push(`${prop}: { ${list.map((p) => `${key(p.wireName)}: params.${p.name}`).join(", ")} },`);
    }
    const body = op.body;
    if (body?.kind === "multipart") {
      lines.push(`body: params.${body.name},`, `multipart: ${partsExpr(body.parts ?? [])},`);
    } else if (body?.kind === "file") {
      const [declared] = body.file?.contentTypes ?? [];
      lines.push(`body: params.${body.name},`, "file: true,", ...(declared ? [`contentType: ${str(declared)},`] : []));
    } else if (body) {
      lines.push(`body: params.${body.name},`, `contentType: ${str(body.contentType)},`);
    }
    if (auth) lines.push(`auth: ${auth},`);
    if (isStream(op)) lines.push(`accept: "text/event-stream",`);
    return lines;
  },

  successLines(op: TsOperation, zod: boolean): string[] {
    const r = op.result;
    if (r.kind === "single" && r.stream) {
      const schema = zod && r.stream.events ? `, ${r.stream.type.schema}${r.stream.type.codec ? ", true" : ""}` : "";
      return [`if (res.ok) return yield* streamEvents(this.config, res, ${eventsExpr(op)}${schema});`];
    }
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
    return [...op.errors]
      .sort((a, b) => statusRank(a.statusCodes) - statusRank(b.statusCodes))
      .map((e) => {
        const key = errorKey(e.statusCodes);
        if (!e.body) return `${key}: (status, body) => new HttpError(status, body)`;
        if (!e.body.codec) return `${key}: (status, body) => new ${e.errorClass.text}(status, body as ${e.body.text})`;
        // An unexpected (non-matching) error body must not throw; fall back to the typed error with the raw body.
        return `${key}: (status, body) => { const r = ${e.body.schema}.safeParse(body); return new ${e.errorClass.text}(status, r.success ? r.data : (body as ${e.body.text})); }`;
      });
  },
};
