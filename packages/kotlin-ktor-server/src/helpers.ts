import {
  camel,
  isJsonContentType,
  kotlinString as str,
  listElement,
  paramDecode,
  paramEncode,
  serializedIn,
  serializerExpr,
  serializerImports,
  typeName,
  type KtBody,
  type KtOperation,
  type KtParam,
  type KtTypeUse,
} from "@abhigyakrishna/tspgen-kotlin";
import type { ServerOperation } from "./context.js";
import { streamLine } from "./sse.js";
import type { KtorServerOptions } from "./options.js";
import type { ServerUnit } from "./units.js";

const STATUS: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "NoContent",
  206: "PartialContent",
  301: "MovedPermanently",
  302: "Found",
  303: "SeeOther",
  304: "NotModified",
  307: "TemporaryRedirect",
  308: "PermanentRedirect",
  400: "BadRequest",
  401: "Unauthorized",
  403: "Forbidden",
  404: "NotFound",
  409: "Conflict",
  500: "InternalServerError",
};

const SOURCES = { path: "pathParam", query: "queryParam", header: "headerParam", cookie: "cookieParam" } as const;

/** `{ <parse> }` turning the wire string into `type`; undefined when the string is used as-is. */
export function converter(type: KtTypeUse): string | undefined {
  const parsed = paramDecode("it", type);
  return parsed === "it" ? undefined : `{ ${parsed} }`;
}

export function convert(expr: string, wire: string, type: KtTypeUse, safe: boolean): string {
  const conv = converter(type);
  return conv ? `${expr}${safe ? "?" : ""}.convertParam(${wire}) ${conv}` : expr;
}

/** Kotlin expression turning a value into its wire string (kotlinx encoding for non-primitives). */
export function encode(expr: string, type: KtTypeUse): string {
  return paramEncode(expr, type);
}

/** A JSON request body read with `receiveJson` and an explicit serializer (see `serializerExpr`). */
function jsonBody(body: KtBody): boolean {
  return isJsonContentType(body.contentType) && serializerExpr(body.type) !== undefined;
}

/** The request body is read with `receiveJson` and an explicit serializer (see `serializerExpr`). */
export function receivesJson(op: KtOperation): boolean {
  return !(op as Partial<ServerOperation>).upload && op.body !== undefined && jsonBody(op.body);
}

/** Response bodies of an operation's success results: the single result (not a stream) or each variant's. */
function responseBodies(op: KtOperation): KtTypeUse[] {
  const r = op.result;
  if (r.kind === "sealed") return r.decl.variants.flatMap((v) => (v.body ? [v.body] : []));
  return r.stream || r.type.text === "Unit" ? [] : [r.type];
}

/** Some success body is written with `respondJson` and an explicit serializer. */
export function respondsJson(op: KtOperation): boolean {
  return responseBodies(op).some((t) => serializerExpr(t) !== undefined);
}

/** Imports of the explicit serializers an operation's routes use for its request and response bodies. */
export function bodySerializerImports(op: KtOperation): string[] {
  return [...(receivesJson(op) ? serializerImports(op.body!.type) : []), ...responseBodies(op).flatMap(serializerImports)];
}

function plain(name: string): string {
  return name.replace(/`/g, "");
}

export interface HandlerField {
  name: string;
  type: KtTypeUse;
}

export interface ResourceParam {
  name: string;
  serialName?: string;
  type: string;
  optional: boolean;
}

function requestFields(op: KtOperation): HandlerField[] {
  const upload = (op as Partial<ServerOperation>).upload;
  return [
    ...op.params.map((p) => ({ name: p.name, type: p.type })),
    ...(upload ? upload.fields : op.body ? [{ name: op.body.name, type: op.body.type }] : []),
    ...((op as Partial<ServerOperation>).context ?? []).map((c) => ({ name: c.name, type: c.type })),
  ];
}

function requestName(op: KtOperation): string {
  return `${typeName(plain(op.name))}Request`;
}

/**
 * Classes with a generated serializer (BigDecimal, java.time) that a `routing-style: resources` operation's
 * `@Resource` class needs for its path/query param properties: kotlinx has no native serializer for them, and the
 * resource class (unlike a data class property) carries no per-property `@Serializable(with = ...)` annotation, so
 * the routes file needs `@file:UseSerializers(...)` instead.
 */
export function resourceSerializedClasses(op: KtOperation): string[] {
  return op.params.filter((p) => p.location === "path" || p.location === "query").flatMap((p) => serializedIn(p.type));
}

/** Exposed to templates as `it.h.ktorServer`. */
export const ktorServerHelpers = {
  status(code: number): string {
    const name = STATUS[code];
    return name ? `HttpStatusCode.${name}` : `HttpStatusCode.fromValue(${code})`;
  },

  /** Kotlin expression reading and converting a request parameter inside a route handler. */
  paramExpr(p: KtParam): string {
    const wire = str(p.wireName);
    const source = `call.${SOURCES[p.location]}(${wire})`;
    const item = listElement(p.type);
    if (item) {
      const mapped = converter(item) ? `.map { ${convert("it", wire, item, false)} }` : "";
      if (p.location === "query" && p.explode) {
        const values = `call.queryParams(${wire})`;
        return p.optional ? `${values}.takeIf { it.isNotEmpty() }${mapped ? `?${mapped}` : ""}` : `${values}${mapped}`;
      }
      const values = `${source}?.split(",")${mapped ? `?${mapped}` : ""}`;
      return p.optional ? values : `(${values}).required(${wire})`;
    }
    if (p.location === "path") return convert(source, wire, p.type, false);
    return p.optional
      ? convert(source, wire, p.type, true)
      : convert(`${source}.required(${wire})`, wire, p.type, false);
  },

  /** Route-handler statements reading the request body: `call.receive…` for JSON, the upload plan's lines otherwise. */
  bodyLines(op: KtOperation): string[] {
    const upload = (op as Partial<ServerOperation>).upload;
    if (upload) return upload.lines;
    return op.body ? [`val ${op.body.name} = ${ktorServerHelpers.bodyExpr(op.body)}`] : [];
  },

  bodyExpr(body: KtBody): string {
    if (jsonBody(body)) return `call.receiveJson(${serializerExpr(body.type)})`;
    return body.optional
      ? `call.receiveNullable<${body.type.text.replace(/\?$/, "")}>()`
      : `call.receive<${body.type.text}>()`;
  },

  requestFields,
  requestName,

  /**
   * The statement responding with `value` of `type`: through its explicit serializer (`respondJson`) when its JSON
   * form needs one (see `serializerExpr`), else Ktor's content negotiation.
   */
  respond(status: string, type: KtTypeUse, value: string): string {
    const serializer = serializerExpr(type);
    return serializer ? `call.respondJson(${status}, ${serializer}, ${value})` : `call.respond(${status}, ${value})`;
  },

  /** The route statement streaming a server-sent event operation's flow. */
  streamLine(op: ServerOperation, call: string): string {
    return streamLine(op.sse ?? "text-writer", call);
  },

  handlerParams(op: KtOperation, options: KtorServerOptions): string {
    const params = options.features["call-access"] ? ["call: ApplicationCall"] : [];
    const fields = requestFields(op);
    if (options["handler-shape"] === "request-object") {
      if (fields.length > 0) params.push(`request: ${requestName(op)}`);
    } else {
      params.push(...fields.map((f) => `${f.name}: ${f.type.text}`));
    }
    return params.join(", ");
  },

  callExpr(op: KtOperation, unit: ServerUnit, options: KtorServerOptions): string {
    const args = options.features["call-access"] ? ["call"] : [];
    const fields = requestFields(op);
    if (options["handler-shape"] === "request-object") {
      if (fields.length > 0) {
        args.push(`${unit.serviceName}.${requestName(op)}(${fields.map((f) => `${f.name} = ${f.name}`).join(", ")})`);
      }
    } else {
      args.push(...fields.map((f) => f.name));
    }
    const call = `service.${op.name}(${args.join(", ")})`;
    const wrap = (op as Partial<ServerOperation>).upload?.wrapCall;
    return wrap ? wrap(call) : call;
  },

  headerWrite(h: KtParam): string {
    const wire = str(h.wireName);
    return h.optional
      ? `result.${h.name}?.let { call.response.header(${wire}, ${encode("it", h.type)}) }`
      : `call.response.header(${wire}, ${encode(`result.${h.name}`, h.type)})`;
  },

  resourceName(op: KtOperation): string {
    return `${typeName(plain(op.name))}Resource`;
  },

  resourceParams(op: KtOperation): ResourceParam[] {
    return op.params
      .filter((p) => p.location === "path" || p.location === "query")
      .map((p) => ({
        name: p.name,
        ...(plain(p.name) !== p.wireName ? { serialName: p.wireName } : {}),
        type: p.type.text,
        optional: p.optional,
      }));
  },

  paramName(unit: ServerUnit): string {
    return camel(unit.serviceName);
  },
};
