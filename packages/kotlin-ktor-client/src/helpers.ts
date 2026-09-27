import type { StatusCodes } from "@abhigyakrishna/tspgen-core";
import {
  camel,
  kotlinString as str,
  listElement,
  paramDecode,
  paramEncode,
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
        return `append(${wire}, http.encodeJson(${value}), jsonPartHeaders(${jsonContentType(p)}))`;
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
    default:
      return [`contentType(ContentType.parse(${str(body.contentType)}))`, `setBody(${body.name})`];
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

  variantArgs(v: KtResultVariant): string {
    const args = [
      ...(v.status === undefined ? ["response.status.value"] : []),
      ...(v.body ? ["response.body()"] : []),
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
        expr: e.body ? `${e.exception.text}(response.body(), response.status.value)` : fallback,
      }));
    if (!branches.some((b) => b.match === "else")) branches.push({ match: "else", expr: fallback });
    return branches;
  },

  stream: streamOf,
  emitLines,
  preludeLines,

  propertyName(group: KtGroup): string {
    return camel(group.name);
  },
};
