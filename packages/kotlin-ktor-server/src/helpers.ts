import {
  camel,
  kotlinString as str,
  typeName,
  type KtBody,
  type KtOperation,
  type KtParam,
  type KtTypeUse,
} from "@abhigyakrishna/tspgen-kotlin";
import type { ServerOperation } from "./context.js";
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

const CONVERTERS: Record<string, string> = {
  Int: "{ it.toInt() }",
  Long: "{ it.toLong() }",
  Short: "{ it.toShort() }",
  Byte: "{ it.toByte() }",
  Double: "{ it.toDouble() }",
  Float: "{ it.toFloat() }",
  Boolean: "{ it.toBooleanStrict() }",
};

const SOURCES = { path: "pathParam", query: "queryParam", header: "headerParam", cookie: "cookieParam" } as const;

function converter(typeText: string): string | undefined {
  if (typeText === "String") return undefined;
  return CONVERTERS[typeText] ?? `{ decodeParam<${typeText}>(it) }`;
}

function convert(expr: string, wire: string, typeText: string, safe: boolean): string {
  const conv = converter(typeText);
  return conv ? `${expr}${safe ? "?" : ""}.convertParam(${wire}) ${conv}` : expr;
}

/** Kotlin expression turning a value into its wire string (kotlinx encoding for non-primitives). */
function encode(expr: string, typeText: string): string {
  if (typeText === "String") return expr;
  return CONVERTERS[typeText] ? `${expr}.toString()` : `encodeParam(${expr})`;
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
  return [
    ...op.params.map((p) => ({ name: p.name, type: p.type })),
    ...(op.body ? [{ name: op.body.name, type: op.body.type }] : []),
    ...((op as Partial<ServerOperation>).context ?? []).map((c) => ({ name: c.name, type: c.type })),
  ];
}

function requestName(op: KtOperation): string {
  return `${typeName(plain(op.name))}Request`;
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
    const typeText = p.type.text.replace(/\?$/, "");
    const source = `call.${SOURCES[p.location]}(${wire})`;
    const item = /^List<(.+)>$/.exec(typeText)?.[1];
    if (item) {
      const mapped = converter(item) ? `.map { ${convert("it", wire, item, false)} }` : "";
      if (p.location === "query" && p.explode) {
        const values = `call.queryParams(${wire})`;
        return p.optional ? `${values}.takeIf { it.isNotEmpty() }${mapped ? `?${mapped}` : ""}` : `${values}${mapped}`;
      }
      const values = `${source}?.split(",")${mapped ? `?${mapped}` : ""}`;
      return p.optional ? values : `(${values}).required(${wire})`;
    }
    if (p.location === "path") return convert(source, wire, typeText, false);
    return p.optional
      ? convert(source, wire, typeText, true)
      : convert(`${source}.required(${wire})`, wire, typeText, false);
  },

  bodyExpr(body: KtBody): string {
    return body.optional
      ? `call.receiveNullable<${body.type.text.replace(/\?$/, "")}>()`
      : `call.receive<${body.type.text}>()`;
  },

  requestFields,
  requestName,

  handlerParams(op: KtOperation, options: KtorServerOptions): string {
    const params = options["call-access"] ? ["call: ApplicationCall"] : [];
    const fields = requestFields(op);
    if (options["handler-shape"] === "request-object") {
      if (fields.length > 0) params.push(`request: ${requestName(op)}`);
    } else {
      params.push(...fields.map((f) => `${f.name}: ${f.type.text}`));
    }
    return params.join(", ");
  },

  callExpr(op: KtOperation, unit: ServerUnit, options: KtorServerOptions): string {
    const args = options["call-access"] ? ["call"] : [];
    const fields = requestFields(op);
    if (options["handler-shape"] === "request-object") {
      if (fields.length > 0) {
        args.push(`${unit.serviceName}.${requestName(op)}(${fields.map((f) => `${f.name} = ${f.name}`).join(", ")})`);
      }
    } else {
      args.push(...fields.map((f) => f.name));
    }
    return `service.${op.name}(${args.join(", ")})`;
  },

  headerWrite(h: KtParam): string {
    const wire = str(h.wireName);
    const typeText = h.type.text.replace(/\?$/, "");
    return h.optional
      ? `result.${h.name}?.let { call.response.header(${wire}, ${encode("it", typeText)}) }`
      : `call.response.header(${wire}, ${encode(`result.${h.name}`, typeText)})`;
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
