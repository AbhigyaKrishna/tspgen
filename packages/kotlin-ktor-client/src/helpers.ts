import type { StatusCodes } from "@abhigyakrishna/tspgen-core";
import {
  camel,
  isJsonContentType,
  kotlinString as str,
  listElement,
  paramDecode,
  paramEncode,
  serializerExpr,
  serializerImports,
  type KtBody,
  type KtGroup,
  type KtOperation,
  type KtParam,
  type KtPart,
  type KtResultVariant,
  type KtTypeUse,
} from "@abhigyakrishna/tspgen-kotlin";
import { emitLines, preludeLines, streamOf } from "./sse.js";

const METHODS = { get: "Get", put: "Put", post: "Post", patch: "Patch", delete: "Delete", head: "Head" } as const;

/** Kotlin expression turning a value into its wire string. */
function encode(expr: string, type: KtTypeUse): string {
  return paramEncode(expr, type);
}

/** Kotlin expression parsing a wire string. */
export function decode(expr: string, type: KtTypeUse): string {
  return paramDecode(expr, type);
}

/**
 * Kotlin expression reading the response body as `type`: through its explicit serializer and the API client's Json when
 * its JSON form needs one (see `serializerExpr`), else `response.body()` (content negotiation).
 */
function bodyRead(type: KtTypeUse): string {
  const serializer = serializerExpr(type);
  return serializer ? `http.apiJson.decodeFromString(${serializer}, response.bodyAsText())` : "response.body()";
}

/** A single JSON request body whose JSON form needs an explicit serializer (see `serializerExpr`). */
function jsonBody(body: KtBody): boolean {
  return body.kind !== "multipart" && body.kind !== "file" && isJsonContentType(body.contentType) && serializerExpr(body.type) !== undefined;
}

/** Bodies of an operation written or read with an explicit serializer: request, success and typed error bodies, JSON parts. */
function serializedTypes(op: KtOperation): KtTypeUse[] {
  const r = op.result;
  const success = r.kind === "sealed" ? r.decl.variants.flatMap((v) => (v.body ? [v.body] : [])) : r.stream || r.type.text === "Unit" ? [] : [r.type];
  const request =
    op.body?.kind === "multipart"
      ? (op.body.parts ?? []).filter((p) => p.kind === "json").map((p) => p.type)
      : op.body?.kind === "file" || !op.body || !isJsonContentType(op.body.contentType)
        ? []
        : [op.body.type];
  const errors = op.errors.flatMap((e) => (e.body ? [e.body] : []));
  return [...request, ...success, ...errors].filter((t) => serializerExpr(t) !== undefined);
}

/** Whether an operation writes or reads a body through an explicit serializer (it then needs the API client's Json). */
export function usesSerializers(op: KtOperation): boolean {
  return serializedTypes(op).length > 0;
}

/** Imports of the explicit serializers an operation's client method uses, and of the calls around them. */
export function serializerCallImports(op: KtOperation): string[] {
  const types = serializedTypes(op);
  if (types.length === 0) return [];
  const read = [...(op.result.kind === "sealed" ? op.result.decl.variants.flatMap((v) => (v.body ? [v.body] : [])) : [op.result.type]), ...op.errors.flatMap((e) => (e.body ? [e.body] : []))];
  return [
    ...types.flatMap(serializerImports),
    ...(read.some((t) => serializerExpr(t)) ? ["io.ktor.client.statement.bodyAsText"] : []),
    ...(op.body && jsonBody(op.body) ? ["io.ktor.http.content.TextContent"] : []),
  ];
}

function statusMatch(codes: StatusCodes): string {
  if (codes === "default") return "else";
  return typeof codes === "number" ? String(codes) : `in ${codes.start}..${codes.end}`;
}

function rank(codes: StatusCodes): number {
  return codes === "default" ? 2 : typeof codes === "number" ? 0 : 1;
}

function headerExpr(h: KtParam): string {
  const wire = str(h.wireName);
  const raw = `response.headers[${wire}]`;
  if (h.optional) {
    const parsed = decode("it", h.type);
    return parsed === "it" ? raw : `${raw}?.let { ${parsed} }`;
  }
  const required = `(${raw} ?: throw ApiException(response.status.value, ${str(`missing header ${h.wireName}`)}))`;
  return decode(required, h.type);
}

function valueExpr(name: string, type: KtTypeUse): string {
  const item = listElement(type);
  return item ? `${name}.joinToString(",") { ${encode("it", item)} }` : encode(name, type);
}

const OCTET_STREAM = "application/octet-stream";

const JSON = "application/json";

/** The declared JSON content type of JSON part `p` as a Kotlin argument; none for `application/json`. */
function jsonContentType(p: KtPart): string {
  const declared = p.contentTypes.find((t) => /[/+]json(;|$)/.test(t)) ?? JSON;
  return declared === JSON ? "" : str(declared);
}

/** `formData { … }` statement appending one part (every item of a multi part) from `body.<name>`. */
function partLine(body: string, p: KtPart): string {
  const wire = str(p.wireName);
  const append = (value: string): string => {
    switch (p.kind) {
      case "file":
        return `append(${wire}, ${value}.bytes, fileHeaders(${value}, ${wire}, ${str(p.contentTypes[0] ?? OCTET_STREAM)}))`;
      case "json":
      {
        const serializer = serializerExpr(p.type);
        return `append(${wire}, http.encodeJson(${serializer ? `${serializer}, ` : ""}${value}), jsonPartHeaders(${jsonContentType(p)}))`;
      }
      case "text":
        return `append(${wire}, ${encode(value, p.type)})`;
    }
  };
  const value = `${body}.${p.name}`;
  if (p.multi) return `${value}${p.optional ? "?" : ""}.forEach { ${append("it")} }`;
  return p.optional ? `${value}?.let { ${append("it")} }` : append(value);
}

/** Statements setting the request body. */
function bodyLines(body: KtBody): string[] {
  switch (body.kind) {
    case "multipart":
      return [
        "setBody(",
        "    MultiPartFormDataContent(",
        "        formData {",
        ...(body.parts ?? []).map((p) => `            ${partLine(body.name, p)}`),
        "        },",
        "    ),",
        ")",
      ];
    case "file":
      return [
        `contentType(ContentType.parse(${body.name}.contentType ?: ${str(body.file?.contentTypes[0] ?? OCTET_STREAM)}))`,
        `${body.name}.filename?.let { header(HttpHeaders.ContentDisposition, ContentDisposition.Attachment.withParameter(ContentDisposition.Parameters.FileName, it).toString()) }`,
        `setBody(${body.name}.bytes)`,
      ];
    default: {
      const serializer = jsonBody(body) ? serializerExpr(body.type) : undefined;
      if (serializer) {
        // The serializer's JSON as the body: content negotiation would write the value with its type's own serializer.
        return [`setBody(TextContent(http.apiJson.encodeToString(${serializer}, ${body.name}), ContentType.parse(${str(body.contentType)})))`];
      }
      return [`contentType(ContentType.parse(${str(body.contentType)}))`, `setBody(${body.name})`];
    }
  }
}

/** Exposed to templates as `it.h.ktorClient`. */
export const ktorClientHelpers = {
  method(verb: keyof typeof METHODS): string {
    return METHODS[verb];
  },

  signature(op: KtOperation): string {
    return [
      ...op.params.map((p) => `${p.name}: ${p.type.text}${p.optional ? " = null" : ""}`),
      ...(op.body ? [`${op.body.name}: ${op.body.type.text}${op.body.optional ? " = null" : ""}`] : []),
    ].join(", ");
  },

  pathSegments(op: KtOperation): string {
    return op.path
      .split("/")
      .filter(Boolean)
      .map((segment) => {
        const name = /^\{(.+)\}$/.exec(segment)?.[1];
        const param = name ? op.params.find((p) => p.location === "path" && p.wireName === name) : undefined;
        return param ? encode(param.name, param.type) : str(segment);
      })
      .join(", ");
  },

  queryLines(op: KtOperation): string[] {
    return op.params
      .filter((p) => p.location === "query")
      .map((p) => {
        const wire = str(p.wireName);
        const item = listElement(p.type);
        if (item && p.explode) {
          return `${p.name}${p.optional ? "?" : ""}.forEach { parameters.append(${wire}, ${encode("it", item)}) }`;
        }
        if (item) {
          return p.optional
            ? `${p.name}?.let { values -> parameters.append(${wire}, ${valueExpr("values", p.type)}) }`
            : `parameters.append(${wire}, ${valueExpr(p.name, p.type)})`;
        }
        return p.optional
          ? `${p.name}?.let { parameters.append(${wire}, ${encode("it", p.type)}) }`
          : `parameters.append(${wire}, ${encode(p.name, p.type)})`;
      });
  },

  requestLines(op: KtOperation): string[] {
    const lines = op.params
      .filter((p) => p.location === "header" || p.location === "cookie")
      .map((p) => {
        const fn = p.location === "header" ? "header" : "cookie";
        const wire = str(p.wireName);
        if (!p.optional) return `${fn}(${wire}, ${valueExpr(p.name, p.type)})`;
        return listElement(p.type)
          ? `${p.name}?.let { values -> ${fn}(${wire}, ${valueExpr("values", p.type)}) }`
          : `${p.name}?.let { ${fn}(${wire}, ${encode("it", p.type)}) }`;
      });
    const body = op.body;
    if (body) {
      const inner = bodyLines(body);
      lines.push(...(body.optional ? [`if (${body.name} != null) {`, ...inner.map((l) => `    ${l}`), "}"] : inner));
    }
    return lines;
  },

  statusMatch,
  bodyRead,

  variantArgs(v: KtResultVariant): string {
    const args = [
      ...(v.status === undefined ? ["response.status.value"] : []),
      ...(v.body ? [bodyRead(v.body)] : []),
      ...v.headers.map(headerExpr),
    ];
    return args.length > 0 ? `(${args.join(", ")})` : "";
  },

  errorBranches(op: KtOperation): { match: string; expr: string }[] {
    const fallback = "ApiException(response.status.value, response.errorMessage())";
    const branches = [...op.errors]
      .sort((a, b) => rank(a.statusCodes) - rank(b.statusCodes))
      .map((e) => ({
        match: statusMatch(e.statusCodes),
        expr: e.body ? `${e.exception.text}(${bodyRead(e.body)}, response.status.value)` : fallback,
      }));
    if (!branches.some((b) => b.match === "else")) branches.push({ match: "else", expr: fallback });
    return branches;
  },

  /**
   * Whether the error dispatch needs the problem-details guard: some error branch decodes a typed body, which an
   * `application/problem+json` response (the generated server's own 4xx/5xx) is not.
   */
  typedErrors(op: KtOperation): boolean {
    return op.errors.some((e) => e.body);
  },

  stream: streamOf,
  emitLines,
  preludeLines,

  propertyName(group: KtGroup): string {
    return camel(group.name);
  },
};
