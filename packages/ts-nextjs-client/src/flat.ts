import { reportUnsupportedFeature, type FileSpec, type TargetContext } from "@abhigyakrishna/tspgen-core";
import {
  API_VERSION_FILE,
  propertyKey,
  rebase,
  relativeSpecifier,
  RESERVED_WORDS,
  renderImports,
  reportDiagnostic,
  type TsImport,
  type TsInterface,
  type TsIR,
  type TsOperation,
  type TsParam,
} from "@abhigyakrishna/tspgen-typescript";
import { NoTarget } from "@typespec/compiler";
import { clientAuth, memberType, type AuthMember, type ClientAuth } from "./auth.js";
import { nextExtras } from "./extras.js";
import { HOOKS_INTERNALS, planFlatReactQuery, QUERIES_INTERNALS, reactQueryNames, varsKeyClash } from "./flat-react-query.js";
import { nextjsHelpers, queryObjectType } from "./helpers.js";
import type { NextClientOptions } from "./options.js";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** Error-model fields not copied onto the error class (set from the response or owned by Error). */
const RESERVED_FIELDS = new Set(["status", "message", "name", "stack", "cause", "body"]);
/** Members of the generated client class; an operation with one of these names would shadow it. */
const CLIENT_MEMBERS = new Set(["constructor", "send", "request", "baseUrl", "doFetch", "headers"]);
/**
 * Globals referenced by templates/ts-nextjs/flat-client.eta (Response, Promise, Record, RequestInit,
 * URLSearchParams, Error, JSON, String, Array, Object, globalThis, encodeURIComponent, fetch, AbortSignal,
 * Omit (RequestDefaults)). A generated declaration with one of these names shadows the global via
 * `import type { X } from "./types"` in client.ts even though only type-position uses of the global are actually
 * affected; the list is kept simple rather than narrowed to exactly which of these appear in type position. Headers,
 * Blob, File and FormData are referenced
 * through globalThis, so same-named generated types are fine. Clients with uploads also use UPLOAD_GLOBALS.
 */
const TEMPLATE_GLOBALS = new Set([
  "Response",
  "Promise",
  "Record",
  "Omit",
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
  "AbortSignal",
]);
/**
 * Globals (BodyInit; Blob, File and FormData are referenced through globalThis) and module-local helpers (RawBody, PartSpec, toFormData) client.ts
 * uses when an operation uploads (multipart or file body); a generated type with one of these names clashes too.
 */
const UPLOAD_GLOBALS = ["BodyInit", "RawBody", "PartSpec", "toFormData"];
/** Module-local helpers client.ts declares when a service uses `@useAuth` (TextEncoder and btoa via globalThis). */
const AUTH_LOCALS = ["AuthScheme", "AuthEntries", "resolveAuth", "base64"];
/** Globals and module-local helpers client.ts uses when an operation streams server-sent events. */
const STREAM_GLOBALS = [
  "AsyncGenerator",
  "AsyncIterable",
  "ReadableStream",
  "TextDecoder",
  "Uint8Array",
  "EventSpec",
  "RawEvent",
  "readEvents",
  "decodeEvents",
  "decodeData",
  "MAX_SSE_SIZE",
];
/** Names tried, in order, for a method's query-object parameter. */
const QUERY_NAMES = ["query", "queryParams", "params"];
/** Names tried, in order, for a method's trailing request-options parameter (`RequestOptions`). */
const INIT_NAMES = ["init", "requestInit", "options"];
const ARRAY_TYPE = /\[\]( \| null)?$|^(readonly )?Array</;
const Z: TsImport = { name: "z", from: "zod", typeOnly: false, external: true };

export interface FlatMethod {
  name: string;
  params: string;
  returnType: string;
  /** Arguments of `this.send(…)` / `this.request(…)`. */
  args: string;
  /** Void result: the method awaits `this.request(…)` and never reads the body. */
  void: boolean;
  /** zod `.parse(…)` statements run before the request (validate option). */
  checks: string[];
  /** A server-sent event stream: an async generator method. */
  stream?: { element: string; events: string; /** Schema decoding each event. */ decode?: string };
  /** Schema decoding the JSON result (it contains a codec): `return <decode>.parse(await this.send(…))`. */
  decode?: string;
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
  /** Schema decoding the error model (it contains a codec). */
  decode?: string;
}

function unsupported(op: TsOperation, auth: boolean): string | undefined {
  if (op.result.kind === "union") return "multiple success responses or response headers";
  const stream = op.result.kind === "single" && op.result.stream !== undefined;
  if (op.result.contentType && !op.result.contentType.includes("json") && !stream) return "a non-JSON response";
  if (CLIENT_MEMBERS.has(op.name) || (auth && op.name === "auth")) return "its name clashes with a client member";
  if (op.params.some((p) => p.location === "path" && p.optional)) return "optional path parameters";
  if (op.params.some((p) => p.location === "header" || p.location === "cookie")) return "header or cookie parameters";
  if (op.body?.kind === "single" && !op.body.contentType.includes("json")) return "a non-JSON body";
  return undefined;
}

/**
 * Local names of a method's path parameters and body. A reserved word (`class`, `default`, …; also `arguments` and
 * `eval`, invalid as strict-mode parameters) and, when method bodies reference the zod import `z` (validate or
 * dates) — a parameter named `z` are renamed `<name>Value` (`<name>Value2`, … avoiding the method's other names).
 * Parameters are positional, so callers are unaffected; `<Op>Vars` keeps the public names.
 */
function localNames(op: TsOperation, usesZ: boolean): { path: TsParam[]; body: string | undefined } {
  const path = op.params.filter((p) => p.location === "path");
  const names = [...path.map((p) => p.name), ...(op.body ? [op.body.name] : [])];
  const renamed = [...names];
  names.forEach((n, i) => {
    if (!RESERVED_WORDS.has(n) && n !== "arguments" && n !== "eval" && !(usesZ && n === "z")) return;
    let replacement = `${n}Value`;
    for (let k = 2; renamed.includes(replacement) || names.includes(replacement); k++) replacement = `${n}Value${k}`;
    renamed[i] = replacement;
  });
  return {
    path: path.map((p, i) => ({ ...p, name: renamed[i]! })),
    body: op.body ? renamed[path.length] : undefined,
  };
}

function method(
  op: TsOperation,
  validate: boolean,
  usesZ: boolean,
  auth: string | undefined,
  next: Record<string, unknown> | undefined,
): FlatMethod {
  const { path, body: bodyName } = localNames(op, usesZ);
  const query = op.params.filter((p) => p.location === "query");
  const params = path.map((p) => `${p.name}: ${p.type.text}`);
  const queryRequired = query.some((p) => !p.optional);
  if (op.body) {
    const optionalTail = op.body.optional && !queryRequired;
    params.push(
      optionalTail ? `${bodyName}?: ${op.body.type.text}` : `${bodyName}: ${op.body.type.text}${op.body.optional ? " | undefined" : ""}`,
    );
  }
  const taken = new Set([...path.map((p) => p.name), ...(bodyName ? [bodyName] : [])]);
  const queryName = pickName(QUERY_NAMES, "params", taken);
  if (query.length > 0) {
    params.push(`${queryName}: ${queryObjectType(query)}${queryRequired ? "" : " = {}"}`);
    taken.add(queryName);
  }
  const initName = pickName(INIT_NAMES, "init", taken);
  params.push(`${initName}?: RequestOptions`);
  const stream = op.result.kind === "single" ? op.result.stream : undefined;
  const exploded = query.filter((p) => p.explode && isArray(p)).map((p) => JSON.stringify(p.wireName));
  const queryCall = exploded.length > 0 ? `toQuery(${queryName}, [${exploded.join(", ")}])` : `toQuery(${queryName})`;
  const url = op.path.replace(/\{([^}]+)\}/g, (match, wire: string) => {
    const p = path.find((x) => x.wireName === wire);
    if (!p) return match;
    return `\${encodeURIComponent(${p.type.date ? `${p.name}.toISOString()` : `String(${p.name})`})}`;
  });
  const dynamic = url !== op.path || query.length > 0;
  const urlExpr = dynamic ? `\`${url}${query.length > 0 ? `\${${queryCall}}` : ""}\`` : JSON.stringify(op.path);
  const checks: string[] = [];
  if (validate) {
    for (const p of path.filter((x) => x.constrained)) checks.push(`${p.type.schema}.parse(${p.name});`);
    if (op.body) {
      // undefined-valued keys are dropped first, as JSON.stringify drops them from what is sent; codec schemas
      // (Dates) are checked by encoding, since parsing expects wire strings
      const input = `withoutUndefined(${bodyName})`;
      const check = op.body.type.codec
        ? `z.encode(${op.body.type.schema}, ${input} as ${op.body.type.text});`
        : `${op.body.type.schema}.parse(${input});`;
      checks.push(op.body.optional ? `if (${bodyName} !== undefined) ${check}` : check);
    }
    if (query.length > 0) {
      const fields = query.map((p) => `${propertyKey(p.wireName)}: ${p.type.schema}${p.optional ? ".optional()" : ""}`);
      const object = `z.object({ ${fields.join(", ")} })`;
      checks.push(query.some((p) => p.type.codec) ? `z.encode(${object}, ${queryName});` : `${object}.parse(${queryName});`);
    }
  }
  // @meta next defaults sit under the caller's options; a stream also asks for text/event-stream.
  const defaults = next ? `next: ${JSON.stringify(next)}, ` : "";
  const initArg = stream
    ? `{ ${defaults}...${initName}, accept: "text/event-stream" }`
    : defaults
      ? `{ ${defaults}...${initName} }`
      : initName;
  const args = [
    JSON.stringify(op.verb.toUpperCase()),
    urlExpr,
    bodyName ? bodyArg(op, bodyName) : "undefined",
    initArg,
    ...(auth ? [auth] : []),
  ];
  const decode = !stream && op.result.type.codec ? op.result.type.schema : undefined;
  return {
    name: op.name,
    params: params.join(", "),
    returnType: op.result.type.text,
    void: op.result.type.text === "void",
    args: args.join(", "),
    checks,
    ...(decode ? { decode } : {}),
    ...(stream
      ? {
          stream: {
            element: stream.type.text,
            events: nextjsHelpers.eventsExpr(op),
            ...(stream.type.codec ? { decode: stream.type.schema } : {}),
          },
        }
      : {}),
    ...(op.docs ? { docs: op.docs } : {}),
    ...(op.deprecated ? { deprecated: op.deprecated } : {}),
  };
}

/** The first of `candidates` not in `taken`, else `<fallback>2`, `<fallback>3`, … */
function pickName(candidates: readonly string[], fallback: string, taken: ReadonlySet<string>): string {
  const found = candidates.find((n) => !taken.has(n));
  if (found) return found;
  let i = 2;
  while (taken.has(`${fallback}${i}`)) i++;
  return `${fallback}${i}`;
}

/** The body argument of send()/request(): uploads are wrapped in RawBody so they are not JSON-encoded. */
function bodyArg(op: TsOperation, name: string): string {
  const body = op.body!;
  let raw: string;
  if (body.kind === "multipart") raw = `new RawBody(toFormData(${name}, ${nextjsHelpers.partsExpr(body.parts ?? [])}))`;
  else if (body.kind === "file") raw = `new RawBody(${name}, ${name}.type || ${JSON.stringify(body.file?.contentTypes[0] ?? "application/octet-stream")})`;
  else return name;
  return body.optional ? `${name} === undefined ? undefined : ${raw}` : raw;
}

function isUpload(op: TsOperation): boolean {
  return op.body?.kind === "multipart" || op.body?.kind === "file";
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
    ...(model.properties.some((p) => p.type.codec) ? { decode: `${model.name}Schema` } : {}),
  };
}

/** `<Service>Auth` members with their spelled-out provider types. */
function flatMembers(members: AuthMember[]): (AuthMember & { type: string })[] {
  return members.map((m) => ({ ...m, type: memberType(m.kind, "flat") }));
}

/**
 * client.ts (one class per service + error class) and index.ts, plus queries.ts and hooks.ts with react-query;
 * nothing when a limitation is hit.
 */
export function planFlatFiles(ir: TsIR & { modelsPrefix?: string }, options: NextClientOptions, ctx: TargetContext): FileSpec[] {
  const fail = (code: Parameters<typeof reportDiagnostic>[1]["code"], format: Record<string, string>, messageId?: string): FileSpec[] => {
    reportDiagnostic(ctx.program, { code, format, target: NoTarget, ...(messageId ? { messageId } : {}) } as Parameters<typeof reportDiagnostic>[1]);
    return [];
  };
  reportUnsupportedFeature(ctx.program, ctx.features, "server-actions", 'client-style "flat"');
  reportUnsupportedFeature(ctx.program, ctx.features, "server-only", 'client-style "flat"');
  if (!ir.zod) {
    reportUnsupportedFeature(ctx.program, ctx.features, "validate", "`features.zod` off on @abhigyakrishna/tspgen-typescript");
  }
  const reactQuery = options.features["react-query"];
  if (!reactQuery) reportUnsupportedFeature(ctx.program, ctx.features, "hooks", "`features.react-query` off");
  const hooks = reactQuery && options.features.hooks;
  const services = ir.services.filter((s) => s.groups.length > 0);
  if (services.length === 0) return [];
  // Per-operation @meta (next, staleTime), read once so an invalid value warns once.
  const extras = nextExtras(ctx, services.flatMap((s) => s.groups));
  const validate = options.features.validate && ir.zod;
  // Dates decode through zod codecs: results, events and error bodies reference `z` and the schemas.
  const dates = ir.dateType === "date";
  const usesZ = validate || dates;

  let model: TsInterface | undefined;
  if (options["error-model"]) {
    const found = ir.declarations.find((d) => d.name === options["error-model"] || d.id === options["error-model"]);
    if (found?.kind !== "interface") return fail("unknown-error-model", { name: options["error-model"] });
    model = found;
  }

  const clientNames = services.map((s) => `${s.name}Client`);
  const usesUploads = services.some((s) => s.groups.some((g) => g.operations.some(isUpload)));
  const auths = new Map<string, ClientAuth>();
  for (const s of services) {
    const found = clientAuth(ctx.program, s, "the flat client");
    if (found) auths.set(s.id, found);
  }
  const authNames = services.filter((s) => auths.has(s.id)).map((s) => `${s.name}Auth`);
  const rqNames = reactQuery ? reactQueryNames(services, hooks) : [];
  const usesStreams = services.some((s) => s.groups.some((g) => g.operations.some(nextjsHelpers.isStream)));
  const exported = new Set([
    options["error-class"],
    "ClientOptions",
    "RequestOptions",
    "RequestDefaults",
    "NextFetchOptions",
    "HeadersInput",
    ...clientNames,
    ...authNames,
    ...rqNames.filter((n) => n.exported).map((n) => n.name),
  ]);
  // With validate, client.ts imports zod's `z`, which a generated type named z would clash with. The React Query
  // files import TanStack Query and React names and declare a module-local context per service. `Date` is not
  // reserved: dateUse's text is `globalThis.Date`, so a generated type named `Date` cannot shadow it (see
  // type-map.ts), and `toText`'s own `instanceof Date` is a value reference a type-only import can't shadow.
  const internal = new Set([
    ...TEMPLATE_GLOBALS,
    ...(usesUploads ? UPLOAD_GLOBALS : []),
    ...(usesStreams ? STREAM_GLOBALS : []),
    ...(usesZ ? ["z"] : []),
    ...(dates ? ["toText"] : []),
    ...(auths.size > 0 ? AUTH_LOCALS : []),
    // Key paths (`shopKeys.nodes.all`) are not identifiers; they only matter for the duplicate check below.
    ...(reactQuery
      ? [...QUERIES_INTERNALS, ...(hooks ? HOOKS_INTERNALS : []), ...rqNames.filter((n) => !n.exported && !n.name.includes(".")).map((n) => n.name)]
      : []),
  ]);
  // index.ts re-exports both the types and client.ts, so any shared name is ambiguous there.
  const clash = ir.declarations.find((d) => exported.has(d.name) || internal.has(d.name));
  if (clash) return fail("flat-client-name-clash", { name: clash.name }, exported.has(clash.name) ? undefined : "local");

  const imports: TsImport[] = [];
  const clients = [];
  for (const service of services) {
    const auth = auths.get(service.id);
    const seen = new Map<string, string>();
    const groups = [];
    for (const group of service.groups) {
      const methods: FlatMethod[] = [];
      for (const op of group.operations) {
        const first = seen.get(op.name);
        if (first) return fail("duplicate-operation-name", { first, second: op.id, name: op.name });
        seen.set(op.name, op.id);
        const reason = unsupported(op, auth !== undefined);
        if (reason) return fail("flat-client-unsupported", { operation: op.id, reason });
        const skipped = reactQuery && !nextjsHelpers.isStream(op) ? varsKeyClash(op) : undefined;
        if (skipped) {
          reportDiagnostic(ctx.program, { code: "flat-react-query-skipped", format: { operation: op.id, reason: skipped }, target: NoTarget });
        }
        imports.push(
          ...op.params.flatMap((p) => p.type.imports),
          ...(op.body?.type.imports ?? []),
          ...op.result.type.imports,
        );
        const m = method(op, validate, usesZ, auth?.descriptor(op), extras[op.id]?.next);
        if (m.checks.length > 0) {
          imports.push(
            Z,
            ...op.params.filter((p) => p.location === "query" || p.constrained).flatMap((p) => p.type.schemaImports),
            ...(op.body?.type.schemaImports ?? []),
          );
        }
        if (m.decode || m.stream?.decode) imports.push(Z, ...op.result.type.schemaImports);
        methods.push(m);
      }
      groups.push({ title: group.name, methods });
    }
    const usesSend = groups.some((g) => g.methods.some((m) => !m.void && !m.stream));
    clients.push({
      name: `${service.name}Client`,
      groups,
      usesSend,
      ...(auth ? { auth: { name: `${service.name}Auth`, service: service.name, members: flatMembers(auth.members) } } : {}),
    });
  }
  if (reactQuery) {
    // Names are unique within a service (duplicate-operation-name); hooks, Vars and keys must be across services too,
    // and must not take another service's `<Service>Auth`.
    const owners = new Map<string, string>(services.filter((s) => auths.has(s.id)).map((s) => [`${s.name}Auth`, s.id]));
    for (const { name, owner } of rqNames) {
      const first = owners.get(name);
      if (first !== undefined && first !== owner) return fail("flat-react-query-name-clash", { first, second: owner, name });
      owners.set(name, owner);
    }
  }
  if (model) {
    imports.push({ name: model.name, from: model.file, typeOnly: true, root: "models" }, ...model.properties.flatMap((p) => p.type.imports));
    if (model.properties.some((p) => p.type.codec)) {
      imports.push({ name: `${model.name}Schema`, from: model.file, typeOnly: false, root: "models" });
    }
  }
  const ops = services.flatMap((s) => s.groups.flatMap((g) => g.operations));
  const queryParams = ops.flatMap((op) => op.params.filter((p) => p.location === "query"));
  const ext = ir.importExtension;
  const prefix = ir.modelsPrefix ?? "";
  const typeFiles = (
    ir.layout === "single-file"
      ? ["types"]
      : ir.barrel
        ? ["models/index"]
        : [...ir.declarations.map((d) => d.file), ...(ir.apiVersions.length > 0 ? [API_VERSION_FILE] : [])]
  ).map((f) => rebase(f, prefix));
  return [
    {
      path: "client.ts",
      template: "ts/file",
      data: {
        imports: renderImports("client", imports, ext, prefix),
        body: "ts-nextjs/flat-client",
        clients,
        error: errorClass(options["error-class"], model),
        usesQuery: queryParams.length > 0,
        usesUploads,
        usesAuth: auths.size > 0,
        usesStreams,
        /** toQuery comma-joins arrays and takes the list of exploded keys. */
        usesArrays: queryParams.some(isArray),
        /** Body checks validate a copy without undefined-valued keys. */
        usesWithoutUndefined: validate && ops.some((op) => op.body !== undefined),
        usesDates: dates,
      },
    },
    {
      path: "index.ts",
      template: "ts/file",
      data: {
        imports: [],
        body: "ts/barrel",
        exports: [...(ir.declarations.length > 0 ? typeFiles : []), "client", ...(reactQuery ? ["queries"] : [])]
          .map((f) => relativeSpecifier("index", f, ext))
          .sort(),
      },
    },
    ...(reactQuery ? planFlatReactQuery(ir, services, extras, { hooks, keyPrefix: options["query-key-prefix"] }) : []),
  ];
}
