import { pascal, type ApiIR, type ModelIR, type OperationIR, type ParamIR, type PropertyIR, type ResponseIR, type TypeIR, type TypeRef } from "@abhigyakrishna/tspgen-core";
import { NoTarget, type Program } from "@typespec/compiler";
import { reportDiagnostic } from "./lib.js";

const GO_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GO_KEYWORDS = new Set([
  "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func", "go", "goto",
  "if", "import", "interface", "map", "package", "range", "return", "select", "struct", "switch", "type", "var",
]);

/** Go's exported identifier form, shared by models and HTTP targets. */
export function goName(name: string): string {
  const result = pascal(name).replace(/[^A-Za-z0-9_]/g, "");
  return /^[A-Za-z_]/.test(result) ? result : `X${result}`;
}

export function validPackage(name: string): boolean {
  return GO_IDENT.test(name) && !GO_KEYWORDS.has(name);
}

export function validModule(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.endsWith("/") &&
    path.split("/").every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) && part !== "." && part !== "..");
}

/** A local placeholder version that respects semantic import version suffixes. */
export function localModuleVersion(path: string): string {
  const suffix = path.match(/\/v([0-9]+)$/);
  return suffix && Number(suffix[1]) >= 2 ? `v${suffix[1]}.0.0` : "v0.0.0";
}

export interface GoType {
  text: string;
  /** A model pointer or nullable type already carries an absence marker. */
  pointer: boolean;
}

export interface GoField {
  name: string;
  type: GoType;
  wireName: string;
  optional: boolean;
}

export type GoDecl =
  | { kind: "struct"; id: string; name: string; fields: GoField[]; typeParameters: string[]; docs?: string }
  | { kind: "enum"; id: string; name: string; base: "string" | "int64" | "float64"; members: { name: string; value: string | number }[]; docs?: string };

export interface GoIR {
  api: ApiIR;
  packageName: string;
  module: string;
  declarations: GoDecl[];
}

function pointer(use: GoType): GoType {
  return use.pointer || use.text === "any" ? use : { text: `*${use.text}`, pointer: true };
}

/** Resolve a core type in the models package, or from a client/server package using `qualifier`. */
export function goType(ref: TypeRef, api: ApiIR, qualifier = "", program?: Program, where = "type"): GoType {
  const types = new Map(api.types.map((t) => [t.id, t]));
  switch (ref.kind) {
    case "named": {
      const decl = types.get(ref.id);
      if (!decl) return unsupported(program, where, `unknown named type ${ref.id}`);
      if (decl.kind === "union" && !decl.variants.every((v) => v.type.kind === "literal" && typeof v.type.value !== "boolean"))
        return unsupported(program, where, "unions are not supported yet");
      const args = ref.args?.map((a) => goType(a, api, qualifier, program, where).text) ?? [];
      const text = `${qualifier}${goName(decl.name)}${args.length ? `[${args.join(", ")}]` : ""}`;
      return decl.kind === "model" ? { text: `*${text}`, pointer: true } : { text, pointer: false };
    }
    case "typeParam":
      return { text: goName(ref.name), pointer: false };
    case "array":
      return { text: `[]${goType(ref.of, api, qualifier, program, where).text}`, pointer: false };
    case "map":
      return { text: `map[string]${goType(ref.of, api, qualifier, program, where).text}`, pointer: false };
    case "nullable":
      return pointer(goType(ref.of, api, qualifier, program, where));
    case "literal":
      return { text: typeof ref.value === "string" ? "string" : typeof ref.value === "boolean" ? "bool" : "float64", pointer: false };
    case "file":
      return unsupported(program, where, "Http.File is not supported yet");
    case "unknown":
      return { text: "any", pointer: false };
    case "scalar": {
      // String-encoded numbers keep their wire representation until a codec is available.
      if (ref.encoding === "string") {
        if (program) unsupported(program, where, "string-encoded numbers need a Go JSON codec");
        return { text: "string", pointer: false };
      }
      const scalars: Record<string, string> = {
        string: "string", url: "string", bytes: "[]byte", decimal: "json.Number", decimal128: "json.Number", boolean: "bool",
        int8: "int8", int16: "int16", int32: "int32", int64: "int64", uint8: "uint8", uint16: "uint16",
        uint32: "uint32", uint64: "uint64", integer: "json.Number", safeint: "int64", float32: "float32", float64: "float64",
        float: "float64", numeric: "json.Number", utcDateTime: "string", offsetDateTime: "string", plainDate: "string",
        plainTime: "string", duration: "string",
      };
      const text = scalars[ref.name];
      return text ? { text, pointer: false } : unsupported(program, where, `scalar ${ref.name} is not supported`);
    }
  }
}

function unsupported(program: Program | undefined, id: string, reason: string): GoType {
  if (program) reportDiagnostic(program, { code: "unsupported-type", format: { id, reason }, target: NoTarget });
  return { text: "any", pointer: false };
}

function chain(model: ModelIR, types: Map<string, TypeIR>): ModelIR[] {
  const result: ModelIR[] = [];
  const visited = new Set<string>();
  let current: ModelIR | undefined = model;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    result.unshift(current);
    const base: TypeIR | undefined = current.baseId ? types.get(current.baseId) : undefined;
    current = base?.kind === "model" ? base : undefined;
  }
  return result;
}

function field(p: PropertyIR, api: ApiIR, program: Program, owner: string): GoField {
  if (p.default !== undefined) unsupported(program, `${owner}.${p.name}`, "model defaults are not applied yet");
  if (!p.wireName || p.wireName.includes(",")) unsupported(program, `${owner}.${p.name}`, "JSON field names cannot be represented in a Go struct tag");
  const type = goType(p.type, api, "", program, `${owner}.${p.name}`);
  return { name: goName(p.name), type: p.optional ? pointer(type) : type, wireName: p.wireName, optional: p.optional };
}

export function transformToGo(program: Program, api: ApiIR, packageName: string, module: string): GoIR {
  if (!validPackage(packageName)) reportDiagnostic(program, { code: "invalid-package", format: { name: packageName }, target: NoTarget });
  if (!validModule(module)) reportDiagnostic(program, { code: "invalid-module", format: { name: module }, target: NoTarget });
  const types = new Map(api.types.map((t) => [t.id, t]));
  const declarations: GoDecl[] = [];
  const seen = new Map<string, string>();
  for (const type of api.types) {
    const name = goName(type.name);
    const first = seen.get(name);
    if (first) reportDiagnostic(program, { code: "duplicate-name", format: { name, first, second: type.id }, target: NoTarget });
    else seen.set(name, type.id);
    if (type.kind === "model") {
      if (type.discriminator) unsupported(program, type.id, "discriminated models are not supported yet");
      if (type.additionalProperties) unsupported(program, type.id, "additional properties are not supported yet");
      const properties = new Map<string, PropertyIR>();
      for (const base of chain(type, types)) for (const property of base.properties) properties.set(property.name, property);
      const fields = [...properties.values()].map((p) => field(p, api, program, type.id));
      const names = new Map<string, string>();
      for (const f of fields) {
        const previous = names.get(f.name);
        if (previous) reportDiagnostic(program, { code: "duplicate-name", format: { name: f.name, first: previous, second: `${type.id}.${f.wireName}` }, target: NoTarget });
        else names.set(f.name, `${type.id}.${f.wireName}`);
      }
      declarations.push({ kind: "struct", id: type.id, name, fields, typeParameters: type.typeParameters?.map(goName) ?? [], ...(type.docs ? { docs: type.docs } : {}) });
    } else if (type.kind === "enum" || (type.kind === "union" && type.variants.every((v) => v.type.kind === "literal" && typeof v.type.value !== "boolean"))) {
      const members = type.kind === "enum"
        ? type.members.map((m) => ({ name: goName(m.name), value: m.value }))
        : type.variants.map((v, i) => ({ name: goName(v.name ?? String(i)), value: (v.type as Extract<TypeRef, { kind: "literal" }>).value as string | number }));
      const firstValue = members[0]?.value;
      const base = typeof firstValue === "string" ? "string" : members.every((m) => Number.isInteger(m.value)) ? "int64" : "float64";
      if (members.some((m) => typeof m.value !== typeof firstValue)) unsupported(program, type.id, "mixed enum value types are not supported");
      declarations.push({ kind: "enum", id: type.id, name, base, members, ...(type.docs ? { docs: type.docs } : {}) });
    } else {
      unsupported(program, type.id, "unions are not supported yet");
    }
  }
  return { api, packageName, module, declarations };
}

export interface GoOperation {
  id: string;
  name: string;
  verb: string;
  path: string;
  params: ParamIR[];
  body?: { type: TypeRef; optional: boolean };
  success: ResponseIR;
  status: number;
}

/** The JSON-only HTTP subset both standard-library targets implement. */
export function goOperations(program: Program, ir: GoIR): GoOperation[] {
  const result: GoOperation[] = [];
  const names = new Map<string, string>();
  for (const service of ir.api.services) for (const group of service.groups) for (const op of group.operations) {
    const name = goName(`${group.name} ${op.name}`);
    const first = names.get(name);
    if (first) reportDiagnostic(program, { code: "duplicate-name", format: { name, first, second: op.id }, target: NoTarget });
    else names.set(name, op.id);
    const reason = unsupportedOperation(op);
    if (reason) {
      reportDiagnostic(program, { code: "unsupported-operation", format: { id: op.id, reason }, target: NoTarget });
      continue;
    }
    const success = op.responses.find((r) => !r.isError)!;
    for (const param of op.params) goType(param.type, ir.api, "", program, `${op.id}.${param.name}`);
    if (op.body) goType(op.body.type, ir.api, "", program, `${op.id} body`);
    if (success.body) goType(success.body.type, ir.api, "", program, `${op.id} response`);
    result.push({
      id: op.id, name, verb: op.verb.toUpperCase(), path: op.path, params: op.params,
      ...(op.body ? { body: { type: op.body.type, optional: op.body.optional } } : {}),
      success, status: success.statusCodes as number,
    });
  }
  return result;
}

function unsupportedOperation(op: OperationIR): string | undefined {
  if (op.auth && op.auth.options.some((option) => option.length > 0)) return "authentication is not supported yet";
  const success = op.responses.filter((r) => !r.isError);
  if (success.length !== 1 || typeof success[0].statusCodes !== "number") return "exactly one fixed-status success response is required";
  if (op.body && (op.body.kind !== "single" || !op.body.contentTypes.some((c) => c.includes("json")))) return "only JSON request bodies are supported";
  if (success[0].body && (success[0].body.stream || !success[0].body.contentTypes.some((c) => c.includes("json"))))
    return "only JSON response bodies are supported";
  if (success[0].headers.length) return "response headers are not supported yet";
  if (op.params.some((p) => p.location === "cookie" || p.type.kind === "array" || p.type.kind === "map" || p.type.kind === "file"))
    return "cookies, collection parameters, and files are not supported yet";
  if (op.params.some((p) => p.type.kind === "named" || p.type.kind === "nullable" || p.type.kind === "unknown"))
    return "only scalar path, query, and header parameters are supported";
  if (op.params.some((p) => p.type.kind === "scalar" && p.type.name === "bytes")) return "byte parameters are not supported yet";
  return undefined;
}
