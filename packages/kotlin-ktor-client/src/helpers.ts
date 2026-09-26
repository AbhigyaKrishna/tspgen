import type { StatusCodes } from "@tspgen/emitter-core";
import {
  camel,
  kotlinString as str,
  type KtGroup,
  type KtOperation,
  type KtParam,
  type KtResultVariant,
} from "@tspgen/emitter-kotlin";

const PARSE: Record<string, string> = {
  Int: "toInt()",
  Long: "toLong()",
  Short: "toShort()",
  Byte: "toByte()",
  Double: "toDouble()",
  Float: "toFloat()",
  Boolean: "toBooleanStrict()",
};

const METHODS = { get: "Get", put: "Put", post: "Post", patch: "Patch", delete: "Delete", head: "Head" } as const;

function bare(typeText: string): string {
  return typeText.replace(/\?$/, "");
}

function listItem(typeText: string): string | undefined {
  return /^List<(.+)>$/.exec(typeText)?.[1];
}

/** Kotlin expression turning a value into its wire string. */
function encode(expr: string, typeText: string): string {
  if (typeText === "String") return expr;
  return PARSE[typeText] ? `${expr}.toString()` : `encodeParam(${expr})`;
}

/** Kotlin expression parsing a wire string. */
function decode(expr: string, typeText: string): string {
  if (typeText === "String") return expr;
  const parse = PARSE[typeText];
  return parse ? `${expr}.${parse}` : `decodeParam<${typeText}>(${expr})`;
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
  const typeText = bare(h.type.text);
  const raw = `response.headers[${wire}]`;
  if (h.optional) return typeText === "String" ? raw : `${raw}?.let { ${decode("it", typeText)} }`;
  const required = `(${raw} ?: throw ApiException(response.status.value, ${str(`missing header ${h.wireName}`)}))`;
  return decode(required, typeText);
}

function valueExpr(name: string, typeText: string): string {
  const item = listItem(typeText);
  return item ? `${name}.joinToString(",") { ${encode("it", item)} }` : encode(name, typeText);
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
        return param ? encode(param.name, bare(param.type.text)) : str(segment);
      })
      .join(", ");
  },

  queryLines(op: KtOperation): string[] {
    return op.params
      .filter((p) => p.location === "query")
      .map((p) => {
        const wire = str(p.wireName);
        const typeText = bare(p.type.text);
        const item = listItem(typeText);
        if (item && p.explode) {
          return `${p.name}${p.optional ? "?" : ""}.forEach { parameters.append(${wire}, ${encode("it", item)}) }`;
        }
        if (item) {
          return p.optional
            ? `${p.name}?.let { values -> parameters.append(${wire}, ${valueExpr("values", typeText)}) }`
            : `parameters.append(${wire}, ${valueExpr(p.name, typeText)})`;
        }
        return p.optional
          ? `${p.name}?.let { parameters.append(${wire}, ${encode("it", typeText)}) }`
          : `parameters.append(${wire}, ${encode(p.name, typeText)})`;
      });
  },

  requestLines(op: KtOperation): string[] {
    const lines = op.params
      .filter((p) => p.location === "header" || p.location === "cookie")
      .map((p) => {
        const fn = p.location === "header" ? "header" : "cookie";
        const wire = str(p.wireName);
        const typeText = bare(p.type.text);
        if (!p.optional) return `${fn}(${wire}, ${valueExpr(p.name, typeText)})`;
        return listItem(typeText)
          ? `${p.name}?.let { values -> ${fn}(${wire}, ${valueExpr("values", typeText)}) }`
          : `${p.name}?.let { ${fn}(${wire}, ${encode("it", typeText)}) }`;
      });
    const body = op.body;
    if (body) {
      const inner = [`contentType(ContentType.parse(${str(body.contentType)}))`, `setBody(${body.name})`];
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
    const fallback = "ApiException(response.status.value, response.bodyAsText())";
    const branches = [...op.errors]
      .sort((a, b) => rank(a.statusCodes) - rank(b.statusCodes))
      .map((e) => ({
        match: statusMatch(e.statusCodes),
        expr: e.body ? `${e.exception.text}(response.body(), response.status.value)` : fallback,
      }));
    if (!branches.some((b) => b.match === "else")) branches.push({ match: "else", expr: fallback });
    return branches;
  },

  propertyName(group: KtGroup): string {
    return camel(group.name);
  },
};
