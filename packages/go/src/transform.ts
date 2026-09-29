import { constantCase, declarationScopes, isFixedStatus, pascal, resolveMeta, type ApiIR, type ConstraintsIR, type ModelIR, type OperationIR, type ParamIR, type PropertyIR, type ResponseIR, type TypeIR, type TypeRef } from "@abhigyakrishna/tspgen-core";
import { NoTarget, type Program } from "@typespec/compiler";
import { reportDiagnostic } from "./lib.js";
import { atLeastGo, resolveGoOptions, type GoNaming, type GoOptions } from "./options.js";

const GO_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GO_KEYWORDS = new Set([
  "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func", "go", "goto",
  "if", "import", "interface", "map", "package", "range", "return", "select", "struct", "switch", "type", "var",
]);

/** Go's exported identifier form, shared by models and HTTP targets. */
export function goName(name: string, naming: GoNaming = {}): string {
  let result = pascal(name).replace(/[^A-Za-z0-9_]/g, "");
  if (naming.initialisms?.length) {
    const initials = new Set(naming.initialisms);
    result = (result.match(/[A-Z]+(?=[A-Z][a-z]|[0-9]|$)|[A-Z]?[a-z]+|[0-9]+|_+/g) ?? [result])
      .map((word) => initials.has(word.toUpperCase()) ? word.toUpperCase() : word).join("");
  }
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
  imports?: string[];
}

export interface GoField {
  name: string;
  type: GoType;
  wireName: string;
  optional: boolean;
  ref: TypeRef;
  constraints?: ConstraintsIR;
  default?: unknown;
  docs?: string;
}

export type GoDecl =
  | { kind: "struct"; id: string; name: string; namespace: string; fields: GoField[]; typeParameters: string[]; validation: boolean; defaults: boolean; docs?: string }
  | { kind: "enum"; id: string; name: string; namespace: string; base: "string" | "int64" | "float64"; members: { name: string; value: string | number }[]; unknown: boolean; docs?: string }
  | { kind: "alias"; id: string; name: string; namespace: string; type: GoType; docs?: string };

export interface GoIR {
  api: ApiIR;
  packageName: string;
  module: string;
  declarations: GoDecl[];
  options: GoOptions;
}

function pointer(use: GoType): GoType {
  return use.pointer || use.text === "any" ? use : { ...use, text: `*${use.text}`, pointer: true };
}

export function goTypeName(type: { id: string; name: string }, options: GoOptions): string {
  if (Object.hasOwn(options.typeNames, type.id)) return options.typeNames[type.id];
  if (Object.hasOwn(options.typeNames, type.name)) return options.typeNames[type.name];
  return goName(type.name, options.naming);
}

export function typeUse(ref: TypeRef, ir: GoIR, qualifier = "models."): GoType {
  return goType(ref, ir.api, qualifier, undefined, "type", ir.options);
}

export function fileName(name: string): string { return constantCase(name).toLowerCase(); }

/** Resolve a core type in the models package, or from a client/server package using `qualifier`. */
export function goType(ref: TypeRef, api: ApiIR, qualifier = "", program?: Program, where = "type", options: GoOptions = resolveGoOptions({})): GoType {
  const types = new Map(api.types.map((t) => [t.id, t]));
  switch (ref.kind) {
    case "named": {
      const decl = types.get(ref.id);
      if (!decl) return unsupported(program, where, `unknown named type ${ref.id}`);
      if (decl.kind === "union" && !decl.variants.every((v) => v.type.kind === "literal" && typeof v.type.value !== "boolean"))
        return unsupported(program, where, "unions are not supported yet");
      const args = ref.args?.map((a) => goType(a, api, qualifier, program, where, options)) ?? [];
      const text = `${qualifier}${goTypeName(decl, options)}${args.length ? `[${args.map((a) => a.text).join(", ")}]` : ""}`;
      return { text: decl.kind === "model" ? `*${text}` : text, pointer: decl.kind === "model", imports: [...new Set(args.flatMap((a) => a.imports ?? []))] };
    }
    case "typeParam":
      return { text: goName(ref.name, options.naming), pointer: false };
    case "array": {
      const item = goType(ref.of, api, qualifier, program, where, options);
      return { ...item, text: `[]${item.text}`, pointer: false };
    }
    case "map": {
      const item = goType(ref.of, api, qualifier, program, where, options);
      return { ...item, text: `map[string]${item.text}`, pointer: false };
    }
    case "nullable":
      return pointer(goType(ref.of, api, qualifier, program, where, options));
    case "literal":
      return { text: typeof ref.value === "string" ? "string" : typeof ref.value === "boolean" ? "bool" : "float64", pointer: false };
    case "file":
      return unsupported(program, where, "Http.File is not supported yet");
    case "unknown":
      return { text: "any", pointer: false };
    case "scalar": {
      if (ref.custom && options.scalarStyle === "alias") {
        const underlying = goType({ ...ref, custom: undefined }, api, qualifier, program, where, options);
        return { text: `${qualifier}${goTypeName(ref.custom, options)}`, pointer: underlying.pointer };
      }
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
      if (["utcDateTime", "offsetDateTime"].includes(ref.name)) scalars[ref.name] = options.dateTime;
      if (["decimal", "decimal128"].includes(ref.name)) scalars[ref.name] = options.decimal;
      if (ref.name === "integer") scalars[ref.name] = options.integer;
      const text = scalars[ref.name];
      return text ? { text, pointer: false, imports: text === "json.Number" ? ["encoding/json"] : text === "time.Time" ? ["time"] : [] } : unsupported(program, where, `scalar ${ref.name} is not supported`);
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

function field(p: PropertyIR, api: ApiIR, program: Program, owner: string, options: GoOptions): GoField {
  if (!p.wireName || p.wireName.includes(",")) unsupported(program, `${owner}.${p.name}`, "JSON field names cannot be represented in a Go struct tag");
  const type = goType(p.type, api, "", program, `${owner}.${p.name}`, options);
  return { name: goName(p.name, options.naming), type: p.optional && options.optionalFields === "pointers" ? pointer(type) : type, wireName: p.wireName, optional: p.optional, ref: p.type,
    ...(p.constraints ? { constraints: p.constraints } : {}), ...(p.default !== undefined ? { default: p.default } : {}), ...(p.docs ? { docs: p.docs } : {}) };
}

export function transformToGo(program: Program, api: ApiIR, packageName: string, module: string, options: GoOptions = resolveGoOptions({})): GoIR {
  if (!validPackage(packageName)) reportDiagnostic(program, { code: "invalid-package", format: { name: packageName }, target: NoTarget });
  if (!validModule(module)) reportDiagnostic(program, { code: "invalid-module", format: { name: module }, target: NoTarget });
  if (!/^1\.[0-9]+(?:\.[0-9]+)?$/.test(options.goVersion) || !atLeastGo(options.goVersion, "1.22")) unsupported(program, "go-version", "Go 1.22 or newer is required");
  const types = new Map(api.types.map((t) => [t.id, t]));
  const declarations: GoDecl[] = [];
  const seen = new Map<string, string>(["ValidationError", "PropertyConstraints", "DecodeJSON", "EncodeJSON", "DecodeParameter", "EncodeParameter", "ValidateValue", "ApplyDefaults", "CheckProperty"].map((name) => [name, "generated models runtime"]));
  const reserve = (name: string, id: string): void => {
    const first = seen.get(name);
    if (first) reportDiagnostic(program, { code: "duplicate-name", format: { name, first, second: id }, target: NoTarget });
    else seen.set(name, id);
  };
  for (const type of api.types) {
    const name = goTypeName(type, options);
    reserve(name, type.id);
    const namespace = type.namespace.join(".");
    const meta = resolveMeta(declarationScopes(type.decorators, type.namespaceDecorators), "go");
    const validation = options.features?.at("validation", meta, "model") ?? options.validation;
    const defaults = options.features?.at("defaults", meta, "model") ?? options.defaults;
    if (type.kind === "model") {
      if (type.discriminator) unsupported(program, type.id, "discriminated models are not supported yet");
      if (type.additionalProperties) unsupported(program, type.id, "additional properties are not supported yet");
      const properties = new Map<string, PropertyIR>();
      for (const base of chain(type, types)) for (const property of base.properties) properties.set(property.name, property);
      const fields = [...properties.values()].map((p) => field(p, api, program, type.id, options));
      const names = new Map<string, string>(validation ? [["Validate", `${type.id} validation method`]] : []);
      for (const f of fields) {
        const previous = names.get(f.name);
        if (previous) reportDiagnostic(program, { code: "duplicate-name", format: { name: f.name, first: previous, second: `${type.id}.${f.wireName}` }, target: NoTarget });
        else names.set(f.name, `${type.id}.${f.wireName}`);
      }
      if (defaults) reserve(`New${name}`, `${type.id} constructor`);
      declarations.push({ kind: "struct", id: type.id, name, namespace, fields, typeParameters: type.typeParameters?.map((p) => goName(p, options.naming)) ?? [], validation, defaults, ...(type.docs ? { docs: type.docs } : {}) });
    } else if (type.kind === "enum" || (type.kind === "union" && type.variants.every((v) => v.type.kind === "literal" && typeof v.type.value !== "boolean"))) {
      const members = type.kind === "enum"
        ? type.members.map((m) => ({ name: goName(m.name, options.naming), value: m.value }))
        : type.variants.map((v, i) => ({ name: goName(v.name ?? String(i), options.naming), value: (v.type as Extract<TypeRef, { kind: "literal" }>).value as string | number }));
      for (const member of members) {
        if (options.naming["enum-members"] === "UPPER_SNAKE") member.name = constantCase(member.name);
        reserve(`${name}${member.name}`, `${type.id}.${member.name}`);
      }
      const firstValue = members[0]?.value;
      if (!members.length) unsupported(program, type.id, "empty enums are not supported");
      const base = typeof firstValue === "string" ? "string" : members.every((m) => Number.isInteger(m.value)) ? "int64" : "float64";
      if (members.some((m) => typeof m.value !== typeof firstValue)) unsupported(program, type.id, "mixed enum value types are not supported");
      const unknown = base === "string" && (options.features?.at("enum-unknown", meta, type.kind) ?? options.enumUnknown);
      if (unknown) reserve(`${name}UNKNOWN`, `${type.id} unknown sentinel`);
      declarations.push({ kind: "enum", id: type.id, name, namespace, base, members, unknown, ...(type.docs ? { docs: type.docs } : {}) });
    } else {
      unsupported(program, type.id, "unions are not supported yet");
    }
  }
  if (options.scalarStyle === "alias") for (const scalar of api.customScalars) {
    const name = goTypeName(scalar, options);
    reserve(name, scalar.id);
    const type = goType({ kind: "scalar", name: scalar.root, ...(scalar.encoding ? { encoding: scalar.encoding } : {}) }, api, "", program, scalar.id, options);
    declarations.push({ kind: "alias", id: scalar.id, name, namespace: scalar.namespace.join("."), type, ...(scalar.docs ? { docs: scalar.docs } : {}) });
  }
  return { api, packageName, module, declarations, options };
}

export interface GoOperation {
  id: string;
  name: string;
  verb: string;
  path: string;
  params: ParamIR[];
  body?: { type: TypeRef; optional: boolean; constraints?: ConstraintsIR };
  success: ResponseIR;
  status: number;
  group: string;
  namespace: string;
  errors: ResponseIR[];
  docs?: string;
}

/** The JSON-only HTTP subset shared by Go client and server targets. */
export function goOperations(program: Program, ir: GoIR): GoOperation[] {
  const result: GoOperation[] = [];
  const names = new Map<string, string>();
  for (const service of ir.api.services) for (const group of service.groups) for (const op of group.operations) {
    const name = goName(ir.options.naming["operation-prefix"] === "none" ? op.name : `${group.name} ${op.name}`, ir.options.naming);
    const first = names.get(name);
    if (first) reportDiagnostic(program, { code: "duplicate-name", format: { name, first, second: op.id }, target: NoTarget });
    else names.set(name, op.id);
    const reason = unsupportedOperation(op);
    if (reason) {
      reportDiagnostic(program, { code: "unsupported-operation", format: { id: op.id, reason }, target: NoTarget });
      continue;
    }
    const success = op.responses.find((r) => !r.isError)!;
    for (const param of op.params) goType(param.type, ir.api, "", program, `${op.id}.${param.name}`, ir.options);
    if (op.body) goType(op.body.type, ir.api, "", program, `${op.id} body`, ir.options);
    if (success.body) goType(success.body.type, ir.api, "", program, `${op.id} response`, ir.options);
    const fields = new Set<string>();
    for (const param of op.params) {
      const field = goName(`${param.location} ${param.name}`, ir.options.naming);
      if (fields.has(field)) reportDiagnostic(program, { code: "duplicate-name", format: { name: field, first: `${op.id} parameter`, second: `${op.id}.${param.name}` }, target: NoTarget });
      fields.add(field);
    }
    result.push({
      id: op.id, name, verb: op.verb.toUpperCase(), path: op.path, params: op.params,
      ...(op.body ? { body: { type: op.body.type, optional: op.body.optional, ...(op.body.constraints ? { constraints: op.body.constraints } : {}) } } : {}),
      success, status: success.statusCodes as number,
      group: group.id, namespace: group.namespace.join("."), errors: op.responses.filter((r) => r.isError), ...(op.docs ? { docs: op.docs } : {}),
    });
  }
  return result;
}

function unsupportedOperation(op: OperationIR): string | undefined {
  if (op.auth && op.auth.options.some((option) => option.length > 0)) return "authentication is not supported yet";
  const success = op.responses.filter((r) => !r.isError);
  if (success.length !== 1 || !isFixedStatus(success[0].statusCodes)) return "exactly one fixed-status success response is required";
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
