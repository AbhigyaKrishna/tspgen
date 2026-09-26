import type { FileSpec, TargetContext } from "@specgen/emitter-core";
import {
  propertyKey,
  relativeSpecifier,
  renderImports,
  reportDiagnostic,
  type TsImport,
  type TsInterface,
  type TsIR,
  type TsOperation,
  type TsParam,
} from "@specgen/emitter-typescript";
import { NoTarget } from "@typespec/compiler";
import type { NextClientOptions } from "./options.js";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** Error-model fields not copied onto the error class (set from the response or owned by Error). */
const RESERVED_FIELDS = new Set(["status", "message", "name", "stack", "cause", "body"]);
/** Members of the generated client class; an operation with one of these names would shadow it. */
const CLIENT_MEMBERS = new Set(["constructor", "send", "request", "baseUrl", "doFetch", "headers"]);
/**
 * Globals referenced by templates/ts-nextjs/flat-client.eta (Response, Promise, Record, RequestInit,
 * URLSearchParams, Error, JSON, String, Array, Object, globalThis, encodeURIComponent, fetch). A generated
 * declaration with one of these names shadows the global via `import type { X } from "./types"` in client.ts
 * even though only type-position uses of the global are actually affected; the list is kept simple rather
 * than narrowed to exactly which of these appear in type position.
 */
const TEMPLATE_GLOBALS = new Set([
  "Response",
  "Promise",
  "Record",
  "RequestInit",
  "URLSearchParams",
  "Error",
  "JSON",
  "String",
  "Array",
  "Object",
  "globalThis",
  "encodeURIComponent",
  "fetch",
]);
/** Names tried, in order, for a method's query-object parameter. */
const QUERY_NAMES = ["query", "queryParams", "params"];
const ARRAY_TYPE = /\[\]( \| null)?$|^(readonly )?Array</;

export interface FlatMethod {
  name: string;
  params: string;
  returnType: string;
  /** Arguments of `this.send(…)` / `this.request(…)`. */
  args: string;
  /** Void result: the method awaits `this.request(…)` and never reads the body. */
  void: boolean;
  docs?: string;
  deprecated?: string;
}

export interface FlatErrorClass {
  name: string;
  /** Error model type name, when configured. */
  model?: string;
  fields: { key: string; type: string }[];
  required: string[];
  /** Expression passed to super(). */
  message: string;
}

function unsupported(op: TsOperation): string | undefined {
  if (op.result.kind === "union") return "multiple success responses or response headers";
  if (op.result.contentType && !op.result.contentType.includes("json")) return "a non-JSON response";
  if (CLIENT_MEMBERS.has(op.name)) return "its name clashes with a client member";
  if (op.params.some((p) => p.location === "path" && p.optional)) return "optional path parameters";
  if (op.params.some((p) => p.location === "header" || p.location === "cookie")) return "header or cookie parameters";
  if (op.body && !op.body.contentType.includes("json")) return "a non-JSON body";
  return undefined;
}

function method(op: TsOperation): FlatMethod {
  const path = op.params.filter((p) => p.location === "path");
  const query = op.params.filter((p) => p.location === "query");
  const params = path.map((p) => `${p.name}: ${p.type.text}`);
  const queryRequired = query.some((p) => !p.optional);
  if (op.body) {
    const optionalTail = op.body.optional && !queryRequired;
    params.push(
      optionalTail ? `${op.body.name}?: ${op.body.type.text}` : `${op.body.name}: ${op.body.type.text}${op.body.optional ? " | undefined" : ""}`,
    );
  }
  const taken = new Set([...path.map((p) => p.name), ...(op.body ? [op.body.name] : [])]);
  let queryName = QUERY_NAMES.find((n) => !taken.has(n));
  for (let i = 2; !queryName; i++) if (!taken.has(`params${i}`)) queryName = `params${i}`;
  if (query.length > 0) {
    const fields = query.map((p) => `${propertyKey(p.wireName)}${p.optional ? "?" : ""}: ${p.type.text}`).join("; ");
    params.push(`${queryName}: { ${fields} }${queryRequired ? "" : " = {}"}`);
  }
  const exploded = query.filter((p) => p.explode && isArray(p)).map((p) => JSON.stringify(p.wireName));
  const queryCall = exploded.length > 0 ? `toQuery(${queryName}, [${exploded.join(", ")}])` : `toQuery(${queryName})`;
  const url = op.path.replace(/\{([^}]+)\}/g, (match, wire: string) => {
    const p = path.find((x) => x.wireName === wire);
    return p ? `\${encodeURIComponent(String(${p.name}))}` : match;
  });
  const dynamic = url !== op.path || query.length > 0;
  const urlExpr = dynamic ? `\`${url}${query.length > 0 ? `\${${queryCall}}` : ""}\`` : JSON.stringify(op.path);
  return {
    name: op.name,
    params: params.join(", "),
    returnType: op.result.type.text,
    void: op.result.type.text === "void",
    args: [JSON.stringify(op.verb.toUpperCase()), urlExpr, ...(op.body ? [op.body.name] : [])].join(", "),
    ...(op.docs ? { docs: op.docs } : {}),
    ...(op.deprecated ? { deprecated: op.deprecated } : {}),
  };
}

function isArray(p: TsParam): boolean {
  return ARRAY_TYPE.test(p.type.text);
}

function errorClass(name: string, model: TsInterface | undefined): FlatErrorClass {
  if (!model) return { name, fields: [], required: [], message: "`Request failed with status ${status}`" };
  const message = model.properties.find((p) => p.wireName === "message" && p.type.text === "string");
  return {
    name,
    model: model.name,
    fields: model.properties
      .filter((p) => IDENTIFIER.test(p.key) && !RESERVED_FIELDS.has(p.key))
      .map((p) => ({ key: p.key, type: p.type.text })),
    required: model.properties.filter((p) => !p.optional).map((p) => p.wireName),
    message: message ? "body?.message ?? `Request failed with status ${status}`" : "`Request failed with status ${status}`",
  };
}

/** client.ts (one class per service + error class) and index.ts; nothing when a limitation is hit. */
export function planFlatFiles(ir: TsIR, options: NextClientOptions, ctx: TargetContext): FileSpec[] {
  const fail = (code: Parameters<typeof reportDiagnostic>[1]["code"], format: Record<string, string>): FileSpec[] => {
    reportDiagnostic(ctx.program, { code, format, target: NoTarget } as Parameters<typeof reportDiagnostic>[1]);
    return [];
  };
  for (const option of ["react-query", "server-actions"] as const) {
    if (options[option] === true) return fail("unsupported-in-flat-style", { option });
  }
  const services = ir.services.filter((s) => s.groups.length > 0);
  if (services.length === 0) return [];

  let model: TsInterface | undefined;
  if (options["error-model"]) {
    const found = ir.declarations.find((d) => d.name === options["error-model"] || d.id === options["error-model"]);
    if (found?.kind !== "interface") return fail("unknown-error-model", { name: options["error-model"] });
    model = found;
  }

  const clientNames = services.map((s) => `${s.name}Client`);
  const exported = new Set([options["error-class"], "ClientOptions", ...clientNames, ...TEMPLATE_GLOBALS]);
  // index.ts re-exports both the types and client.ts, so any shared name is ambiguous there.
  const clash = ir.declarations.find((d) => exported.has(d.name));
  if (clash) return fail("flat-client-name-clash", { name: clash.name });

  const imports: TsImport[] = [];
  const clients = [];
  for (const service of services) {
    const seen = new Map<string, string>();
    const groups = [];
    for (const group of service.groups) {
      const methods: FlatMethod[] = [];
      for (const op of group.operations) {
        const first = seen.get(op.name);
        if (first) return fail("duplicate-operation-name", { first, second: op.id, name: op.name });
        seen.set(op.name, op.id);
        const reason = unsupported(op);
        if (reason) return fail("flat-client-unsupported", { operation: op.id, reason });
        imports.push(
          ...op.params.flatMap((p) => p.type.imports),
          ...(op.body?.type.imports ?? []),
          ...op.result.type.imports,
        );
        methods.push(method(op));
      }
      groups.push({ title: group.name, methods });
    }
    const usesSend = groups.some((g) => g.methods.some((m) => !m.void));
    clients.push({ name: `${service.name}Client`, groups, usesSend });
  }
  if (model) {
    imports.push({ name: model.name, from: model.file, typeOnly: true }, ...model.properties.flatMap((p) => p.type.imports));
  }
  const ops = services.flatMap((s) => s.groups.flatMap((g) => g.operations));
  const queryParams = ops.flatMap((op) => op.params.filter((p) => p.location === "query"));
  const ext = ir.importExtension;
  const typesFile = ir.layout === "single-file" ? "types" : "models/index";
  return [
    {
      path: "client.ts",
      template: "ts/file",
      data: {
        imports: renderImports("client", imports, ext),
        body: "ts-nextjs/flat-client",
        clients,
        error: errorClass(options["error-class"], model),
        usesQuery: queryParams.length > 0,
        /** toQuery comma-joins arrays and takes the list of exploded keys. */
        usesArrays: queryParams.some(isArray),
      },
    },
    {
      path: "index.ts",
      template: "ts/file",
      data: {
        imports: [],
        body: "ts/barrel",
        exports: [...(ir.declarations.length > 0 ? [typesFile] : []), "client"]
          .map((f) => relativeSpecifier("index", f, ext))
          .sort(),
      },
    },
  ];
}
