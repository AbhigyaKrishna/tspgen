import type { ApiIR, TypeIR, TypeRef } from "@abhigyakrishna/tspgen-core";
import type { Program } from "@typespec/compiler";
import { goName } from "../naming.js";
import { resolveGoOptions, type GoOptions } from "../options.js";
import { unsupported } from "./diagnostics.js";
import type { GoIR, GoType } from "./model.js";

const SCALAR_TYPES: Record<string, string> = {
  string: "string",
  url: "string",
  bytes: "[]byte",
  boolean: "bool",
  int8: "int8",
  int16: "int16",
  int32: "int32",
  int64: "int64",
  uint8: "uint8",
  uint16: "uint16",
  uint32: "uint32",
  uint64: "uint64",
  safeint: "int64",
  float32: "float32",
  float64: "float64",
  float: "float64",
  numeric: "json.Number",
  plainDate: "string",
  plainTime: "string",
  duration: "string",
};

interface TypeContext {
  types: Map<string, TypeIR>;
  qualifier: string;
  program?: Program;
  where: string;
  options: GoOptions;
}

export function pointer(type: GoType): GoType {
  if (type.pointer || type.text === "any") return type;
  return { ...type, text: `*${type.text}`, pointer: true };
}

export function goTypeName(type: { id: string; name: string }, options: GoOptions): string {
  if (Object.hasOwn(options.typeNames, type.id)) return options.typeNames[type.id];
  if (Object.hasOwn(options.typeNames, type.name)) return options.typeNames[type.name];
  return goName(type.name, options.naming);
}

export function typeUse(ref: TypeRef, ir: GoIR, qualifier = "models."): GoType {
  return goType(ref, ir.api, qualifier, undefined, "type", ir.options);
}

/** Resolve types once per traversal, carrying package qualification into nested types. */
export function goType(
  ref: TypeRef,
  api: ApiIR,
  qualifier = "",
  program?: Program,
  where = "type",
  options: GoOptions = resolveGoOptions({}),
): GoType {
  return resolveType(ref, { types: new Map(api.types.map((type) => [type.id, type])), qualifier, program, where, options });
}

function resolveType(ref: TypeRef, ctx: TypeContext): GoType {
  switch (ref.kind) {
    case "named": return namedType(ref, ctx);
    case "scalar": return scalarType(ref, ctx);
    case "typeParam": return { text: goName(ref.name, ctx.options.naming), pointer: false };
    case "array": {
      const item = resolveType(ref.of, ctx);
      return { ...item, text: `[]${item.text}`, pointer: false };
    }
    case "map": {
      const item = resolveType(ref.of, ctx);
      return { ...item, text: `map[string]${item.text}`, pointer: false };
    }
    case "nullable": return pointer(resolveType(ref.of, ctx));
    case "literal": {
      const text = typeof ref.value === "string" ? "string" : typeof ref.value === "boolean" ? "bool" : "float64";
      return { text, pointer: false };
    }
    case "file": return unsupported(ctx.program, ctx.where, "Http.File is not supported yet");
    case "unknown": return { text: "any", pointer: false };
  }
}

function namedType(ref: Extract<TypeRef, { kind: "named" }>, ctx: TypeContext): GoType {
  const decl = ctx.types.get(ref.id);
  if (!decl) return unsupported(ctx.program, ctx.where, `unknown named type ${ref.id}`);
  if (decl.kind === "union" && !decl.variants.every((variant) =>
    variant.type.kind === "literal" && typeof variant.type.value !== "boolean",
  )) {
    return unsupported(ctx.program, ctx.where, "unions are not supported yet");
  }
  const args = ref.args?.map((arg) => resolveType(arg, ctx)) ?? [];
  const parameters = args.length ? `[${args.map((arg) => arg.text).join(", ")}]` : "";
  const name = `${ctx.qualifier}${goTypeName(decl, ctx.options)}${parameters}`;
  return {
    text: decl.kind === "model" ? `*${name}` : name,
    pointer: decl.kind === "model",
    imports: [...new Set(args.flatMap((arg) => arg.imports ?? []))],
  };
}

function scalarType(ref: Extract<TypeRef, { kind: "scalar" }>, ctx: TypeContext): GoType {
  if (ref.custom && ctx.options.scalarStyle === "alias") {
    const underlying = scalarType({ ...ref, custom: undefined }, ctx);
    return { text: `${ctx.qualifier}${goTypeName(ref.custom, ctx.options)}`, pointer: underlying.pointer };
  }
  // String-encoded numbers keep their wire representation until a codec is available.
  if (ref.encoding === "string") {
    if (ctx.program) unsupported(ctx.program, ctx.where, "string-encoded numbers need a Go JSON codec");
    return { text: "string", pointer: false };
  }
  let text: string | undefined;
  switch (ref.name) {
    case "utcDateTime":
    case "offsetDateTime": text = ctx.options.dateTime; break;
    case "decimal":
    case "decimal128": text = ctx.options.decimal; break;
    case "integer": text = ctx.options.integer; break;
    default: text = SCALAR_TYPES[ref.name];
  }
  if (!text) return unsupported(ctx.program, ctx.where, `scalar ${ref.name} is not supported`);
  const imports = text === "json.Number" ? ["encoding/json"] : text === "time.Time" ? ["time"] : [];
  return { text, pointer: false, imports };
}
