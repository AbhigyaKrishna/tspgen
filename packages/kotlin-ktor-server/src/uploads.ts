import { reportDiagnostic } from "@abhigyakrishna/tspgen-core";
import { kotlinString as str, typeName, type KtBody, type KtPart, type KtTypeUse } from "@abhigyakrishna/tspgen-kotlin";
import { NoTarget, type Program } from "@typespec/compiler";
import type { ServerOperation } from "./context.js";
import { convert, converter, type HandlerField } from "./helpers.js";

export type MultipartMode = "buffered" | "streaming" | "raw";

const MODES: readonly MultipartMode[] = ["buffered", "streaming", "raw"];

/** How a multipart or file body reaches the service, per the `multipart` option / meta key. */
export interface ServerUpload {
  mode: MultipartMode;
  kind: "multipart" | "file";
  /** Service parameters replacing the body parameter, in order. */
  fields: HandlerField[];
  /** Route-handler statements reading the body (the template indents them). */
  lines: string[];
  /** Imports the routes file needs for `lines`. */
  routeImports: string[];
  /** ServerSupport.kt helpers `lines` call. */
  support: SupportNeed[];
  /**
   * Wraps the service call: raw multipart receives the parts around it, where the service reads them (only the
   * parser's own limit failure becomes 413, see `withMultipart`).
   */
  wrapCall?: (call: string) => string;
}

/** A streaming multipart part class: `sealed class <Model>Part`, declared once per model in the server package. */
export interface PartClass {
  name: string;
  /** KDoc comment lines, before the `sealed class` line (which the template renders with the visibility prefix). */
  doc: string[];
  /** Subclass lines and the closing brace, after the `sealed class <name> {` line. */
  body: string[];
  imports: string[];
}

/** Groups of multipart helpers in ServerSupport.kt, emitted only when some route calls them. */
export type SupportNeed = "limit" | "parts" | "json" | "buffered" | "files" | "streaming" | "channel" | "file";

const FLOW = "kotlinx.coroutines.flow.Flow";
const CHANNEL = "io.ktor.utils.io.ByteReadChannel";

/** Streaming part classes of the whole API: one per multipart model, names unique within the server package. */
export class PartClasses {
  private readonly byModel = new Map<string, PartClass>();
  private readonly names = new Set<string>();

  constructor(readonly pkg: string) {}

  /** The part class of multipart model `fqn` (its parts `parts`), declared on first use. */
  of(fqn: string, parts: KtPart[]): PartClass {
    const existing = this.byModel.get(fqn);
    if (existing) return existing;
    const segments = fqn.split(".");
    let name = `${typeName(segments.pop()!)}Part`;
    // A different model with the same simple name: prefix enclosing package segments, then number.
    while (this.names.has(name) && segments.length > 0) name = `${typeName(segments.pop()!)}${name}`;
    for (let i = 2; this.names.has(name); i++) name = `${name.replace(/\d+$/, "")}${i}`;
    this.names.add(name);
    const decl = partClass(name, fqn.slice(fqn.lastIndexOf(".") + 1), parts);
    this.byModel.set(fqn, decl);
    return decl;
  }

  all(): PartClass[] {
    return [...this.byModel.values()];
  }
}

const use = (text: string, imports: string[] = []): KtTypeUse => ({ text, imports, nullable: false });

/** `multipart` from `@meta("kotlin:ktor-server", …)`, else the target option; invalid values warn. */
export function multipartMode(program: Program, op: ServerOperation, fallback: MultipartMode): MultipartMode {
  const value = (op.meta["kotlin:ktor-server"] ?? {}).multipart;
  if (value === undefined) return fallback;
  if (typeof value === "string" && (MODES as readonly string[]).includes(value)) return value as MultipartMode;
  reportDiagnostic(program, {
    code: "invalid-meta",
    format: { key: "multipart", where: op.id, expected: '"buffered", "streaming" or "raw"' },
    target: NoTarget,
  });
  return fallback;
}

/** `maxUploadSize` from `@meta("kotlin:ktor-server", …)`, else the target option; invalid values warn. */
export function uploadLimit(program: Program, op: ServerOperation, fallback: number): number {
  const value = (op.meta["kotlin:ktor-server"] ?? {}).maxUploadSize;
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  reportDiagnostic(program, {
    code: "invalid-meta",
    format: { key: "maxUploadSize", where: op.id, expected: "a positive integer (bytes)" },
    target: NoTarget,
  });
  return fallback;
}

function plain(name: string): string {
  return name.replace(/`/g, "");
}

/** `preferred` unless a parameter of the operation already uses it; then `<body>` + Preferred. */
function freeName(op: ServerOperation, preferred: string): string {
  const taken = new Set([...op.params.map((p) => plain(p.name)), ...op.context.map((c) => plain(c.name))]);
  return taken.has(preferred) ? `${plain(op.body!.name)}${typeName(preferred)}` : preferred;
}

/** The upload plan of an operation with a multipart or file body; undefined for other bodies. */
/** `flowClash`: a generated type is named Flow, so the streaming mode writes kotlinx's Flow qualified (its import would clash). */
export function planUpload(
  op: ServerOperation,
  mode: MultipartMode,
  limit: number,
  classes: PartClasses,
  flowClash = false,
): ServerUpload | undefined {
  const body = op.body;
  if (!body || body.kind === "single") return undefined;
  if (body.kind === "file") return fileUpload(op, body, mode, `${limit}L`);
  return multipartUpload(op, body, mode, `${limit}L`, classes, flowClash);
}

function fileUpload(op: ServerOperation, body: KtBody, mode: MultipartMode, limit: string): ServerUpload {
  switch (mode) {
    case "buffered":
      return {
        mode,
        kind: "file",
        fields: [{ name: body.name, type: body.type }],
        lines: [`val ${body.name} = call.receiveFile(${limit})`],
        routeImports: [],
        support: ["file"],
      };
    case "streaming": {
      const contentType = freeName(op, "contentType");
      const channel = freeName(op, "channel");
      return {
        mode,
        kind: "file",
        fields: [
          { name: contentType, type: { text: "String?", imports: [], nullable: true } },
          { name: channel, type: use("ByteReadChannel", [CHANNEL]) },
        ],
        lines: [`val ${contentType} = call.request.headers[HttpHeaders.ContentType]`, `val ${channel} = call.receiveChannel()`],
        routeImports: ["io.ktor.http.HttpHeaders", "io.ktor.server.request.receiveChannel"],
        support: [],
      };
    }
    case "raw": {
      const channel = freeName(op, "channel");
      return {
        mode,
        kind: "file",
        fields: [{ name: channel, type: use("ByteReadChannel", [CHANNEL]) }],
        lines: [`val ${channel} = call.receiveChannel()`],
        routeImports: ["io.ktor.server.request.receiveChannel"],
        support: [],
      };
    }
  }
}

function multipartUpload(
  op: ServerOperation,
  body: KtBody,
  mode: MultipartMode,
  limit: string,
  classes: PartClasses,
  flowClash: boolean,
): ServerUpload {
  const parts = body.parts ?? [];
  const partImports = parts.filter((p) => p.kind !== "file").flatMap((p) => p.type.imports);
  const json = parts.some((p) => p.kind === "json") ? (["json"] as const) : [];
  const hasFiles = parts.some((p) => p.kind === "file");
  const model = body.type.text.replace(/\?$/, "");
  switch (mode) {
    case "buffered": {
      const names = (kind: "file" | "text"): string => {
        const wires = parts.filter((p) => (p.kind === "file") === (kind === "file")).map((p) => str(p.wireName));
        return wires.length > 0 ? `setOf(${wires.join(", ")})` : "emptySet()";
      };
      const multi = parts.filter((p) => p.multi).map((p) => str(p.wireName));
      const multiArg = multi.length > 0 ? `, multiParts = setOf(${multi.join(", ")})` : "";
      return {
        mode,
        kind: "multipart",
        fields: [{ name: body.name, type: body.type }],
        lines: [
          `val ${body.name} = call.receiveParts(${limit}, ${names("text")}${hasFiles ? `, ${names("file")}` : ""}${multiArg}).let { parts ->`,
          `    ${model}(`,
          ...parts.map((p) => `        ${p.name} = ${bufferedPartExpr(p)},`),
          "    )",
          "}",
        ],
        routeImports: [...body.type.imports, ...partImports],
        support: ["limit", "parts", "buffered", ...json, ...(hasFiles ? (["files"] as const) : [])],
      };
    }
    case "streaming": {
      const fqn = body.type.imports.find((i) => i.endsWith(`.${model}`)) ?? model;
      const decl = classes.of(fqn, parts);
      const own = `${classes.pkg}.${decl.name}`;
      const param = freeName(op, "parts");
      return {
        mode,
        kind: "multipart",
        fields: [{ name: param, type: flowClash ? use(`${FLOW}<${decl.name}>`, [own]) : use(`Flow<${decl.name}>`, [FLOW, own]) }],
        lines: [
          `val ${param} = call.partsFlow<${decl.name}>(${limit}) { part ->`,
          "    when (part.name) {",
          ...parts.map((p) => `        ${str(p.wireName)} -> emit(${decl.name}.${variantName(p)}(${streamingArgs(p)}))`),
          "    }",
          "}",
        ],
        routeImports: [...partImports, own],
        support: ["limit", "parts", "streaming", ...json, ...(hasFiles ? (["channel"] as const) : [])],
      };
    }
    case "raw": {
      const param = freeName(op, "data");
      return {
        mode,
        kind: "multipart",
        fields: [{ name: param, type: use("MultiPartData", ["io.ktor.http.content.MultiPartData"]) }],
        lines: [],
        routeImports: [],
        support: ["limit"],
        wrapCall: (call) => `call.withMultipart(${limit}) { ${param} -> ${call} }`,
      };
    }
  }
}

/** Expression converting the text `expr` of a text/json part to its Kotlin value. */
function decodeText(expr: string, p: KtPart, safe: boolean): string {
  const wire = str(p.wireName);
  if (p.kind === "json") return `${expr}${safe ? "?" : ""}.convertParam(${wire}) { partJson.decodeFromString<${p.type.text}>(it) }`;
  return convert(expr, wire, p.type, safe);
}

function needsDecode(p: KtPart): boolean {
  return p.kind === "json" || converter(p.type) !== undefined;
}

function bufferedPartExpr(p: KtPart): string {
  const wire = str(p.wireName);
  if (p.kind === "file") {
    if (p.multi) return p.optional ? `parts.files(${wire}).takeIf { it.isNotEmpty() }` : `parts.files(${wire})`;
    return p.optional ? `parts.file(${wire})` : `parts.file(${wire}).required(${wire})`;
  }
  if (p.multi) {
    const values = `parts.texts(${wire})`;
    const mapped = needsDecode(p) ? `.map { ${decodeText("it", p, false)} }` : "";
    return p.optional ? `${values}.takeIf { it.isNotEmpty() }${mapped ? `?${mapped}` : ""}` : `${values}${mapped}`;
  }
  return p.optional ? decodeText(`parts.text(${wire})`, p, true) : decodeText(`parts.text(${wire}).required(${wire})`, p, false);
}

function variantName(p: KtPart): string {
  return typeName(plain(p.name));
}

function streamingArgs(p: KtPart): string {
  if (p.kind === "file") return "part.partFileName(), part.contentType?.toString(), part.partChannel()";
  return decodeText("part.partText()", p, false);
}

const BUILTINS: Record<string, string> = {
  String: "kotlin.String",
  Int: "kotlin.Int",
  Long: "kotlin.Long",
  Short: "kotlin.Short",
  Byte: "kotlin.Byte",
  Double: "kotlin.Double",
  Float: "kotlin.Float",
  Boolean: "kotlin.Boolean",
  List: "kotlin.collections.List",
  Map: "kotlin.collections.Map",
};

/** Qualifies simple names in `type` that a nested class of the sealed part class would shadow. */
function unshadow(type: KtTypeUse, shadowed: ReadonlySet<string>): string {
  return type.text.replace(/(?<![\w.`])[A-Za-z_][A-Za-z0-9_]*/g, (id) =>
    shadowed.has(id) ? (type.imports.find((i) => i.endsWith(`.${id}`)) ?? BUILTINS[id] ?? id) : id,
  );
}

/**
 * `sealed class <Body>Part` with one subclass per part. Value types a subclass name would shadow are written
 * qualified (and not imported).
 */
function partClass(name: string, model: string, parts: KtPart[]): PartClass {
  const shadowed = new Set([name, ...parts.map(variantName)]);
  const nullableString = { text: "String?", imports: [], nullable: true };
  const imports = [
    ...parts.filter((p) => p.kind !== "file").flatMap((p) => p.type.imports),
    ...(parts.some((p) => p.kind === "file") ? [CHANNEL] : []),
  ].filter((fqn) => !shadowed.has(fqn.slice(fqn.lastIndexOf(".") + 1)));
  const doc = [
    "/**",
    ` * One part of ${/^[AEIOU]/.test(model) ? "an" : "a"} \`${model}\` multipart request. The service's \`Flow\` reads the request while it is collected: collect`,
    ...(parts.some((p) => p.kind === "file")
      ? [
          " * it once (a second collection throws IllegalStateException); a file part's `channel` is readable only until the",
          " * collector returns for that part.",
        ]
      : [" * it once (a second collection throws IllegalStateException)."]),
    " */",
  ];
  const body = [
    ...parts.map((p) =>
      p.kind === "file"
        ? `    class ${variantName(p)}(val filename: ${unshadow(nullableString, shadowed)}, val contentType: ${unshadow(nullableString, shadowed)}, val channel: ${unshadow(use("ByteReadChannel", [CHANNEL]), shadowed)}) : ${name}()`
        : `    data class ${variantName(p)}(val value: ${unshadow(p.type, shadowed)}) : ${name}()`,
    ),
    "}",
  ];
  return { name, doc, body, imports };
}
