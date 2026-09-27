import { posix } from "node:path";
import type { TsTypeUse } from "./model.js";

const INT = "z.number().int()";
/** A base-10 integer sent as a JSON string (`@encode(string)`). */
export const INTEGER_STRING = "z.string().regex(/^-?\\d+$/)";
/** An unsigned base-10 integer sent as a JSON string (`@encode(string)` on `uint*`): no leading `-`. */
export const UNSIGNED_INTEGER_STRING = "z.string().regex(/^\\d+$/)";
/** A decimal sent as a JSON string: what Kotlin's `BigDecimal.toPlainString()` (and exponent forms) write. */
export const DECIMAL_STRING = "z.string().regex(/^-?\\d+(\\.\\d+)?([eE][+-]?\\d+)?$/)";

/** TypeSpec std scalar → [TS type, zod schema]. */
const SCALARS: Record<string, [string, string]> = {
  string: ["string", "z.string()"],
  url: ["string", "z.string()"],
  bytes: ["string", "z.string()"],
  decimal: ["string", DECIMAL_STRING],
  decimal128: ["string", DECIMAL_STRING],
  boolean: ["boolean", "z.boolean()"],
  int8: ["number", INT],
  int16: ["number", INT],
  int32: ["number", INT],
  int64: ["number", INT],
  uint8: ["number", INT],
  uint16: ["number", INT],
  uint32: ["number", INT],
  uint64: ["number", INT],
  integer: ["number", INT],
  safeint: ["number", INT],
  float32: ["number", "z.number()"],
  float64: ["number", "z.number()"],
  float: ["number", "z.number()"],
  numeric: ["number", "z.number()"],
  utcDateTime: ["string", "z.iso.datetime({ offset: true })"],
  offsetDateTime: ["string", "z.iso.datetime({ offset: true })"],
  plainDate: ["string", "z.iso.date()"],
  plainTime: ["string", "z.iso.time()"],
  duration: ["string", "z.iso.duration()"],
};

export function simple(text: string, schema: string): TsTypeUse {
  return { text, imports: [], schema, schemaImports: [] };
}

export const UNKNOWN = simple("unknown", "z.unknown()");
export const VOID = simple("void", "z.void()");
/** `Http.File`: a DOM Blob (a `File` is one), checked with `instanceof`; via globalThis so a generated type named Blob cannot shadow it. */
export const FILE = simple("globalThis.Blob", "z.instanceof(globalThis.Blob)");

/** `encoding: "string"` (only set by core on integers and decimals): a JSON string holding the number. */
export function scalarUse(name: string, encoding?: "string"): TsTypeUse {
  if (encoding === "string") {
    if (name.startsWith("decimal")) return simple("string", DECIMAL_STRING);
    return simple("string", name.startsWith("uint") ? UNSIGNED_INTEGER_STRING : INTEGER_STRING);
  }
  const [text, schema] = SCALARS[name] ?? SCALARS.string;
  return simple(text, schema);
}

/**
 * `utcDateTime` with `date-type: date`: a `Date`, validated and converted by `dateTimeCodec` declared in `file`.
 * `text` is `globalThis.Date` (like `FILE`'s `globalThis.Blob`) so a generated type named `Date` cannot shadow it;
 * `date: true` is a structural marker clients use instead of comparing `text` (which would otherwise still be
 * ambiguous with a `@TS.type("Date")` override).
 */
export function dateUse(file: string): TsTypeUse {
  return {
    text: "globalThis.Date",
    imports: [],
    schema: "dateTimeCodec",
    schemaImports: [{ name: "dateTimeCodec", from: file, typeOnly: false, root: "models" }],
    codec: true,
    date: true,
  };
}

/** `codec: true` when any of `uses` is one, else nothing (keeps non-codec uses free of the key). */
function codecOf(uses: readonly TsTypeUse[]): { codec?: true } {
  return uses.some((u) => u.codec) ? { codec: true } : {};
}

export function literalUse(value: string | number | boolean): TsTypeUse {
  const literal = typeof value === "string" ? JSON.stringify(value) : String(value);
  return simple(literal, `z.literal(${literal})`);
}

/**
 * `fromRoot`: a module starting with "." is relative to the output root (rebased per generated file), not
 * copied verbatim — used for `@TS.type`'s module argument. Other callers (e.g. `@meta` `supertypes.from`) keep
 * the module as an opaque, unrebased specifier.
 */
export function externalUse(name: string, module?: string, fromRoot = false): TsTypeUse {
  const relative = fromRoot && (module?.startsWith(".") ?? false);
  return {
    text: name,
    imports: module
      ? [
          relative
            ? { name, from: posix.normalize(module), typeOnly: true, root: "models" as const }
            : { name, from: module, typeOnly: true, external: true },
        ]
      : [],
    schema: `z.custom<${name}>()`,
    schemaImports: [],
  };
}

/** `codec`: the declaration's schema contains a codec (see `DeclarationBuilder.computeCodecs`). */
export function declUse(name: string, file: string, codec = false): TsTypeUse {
  return {
    text: name,
    imports: [{ name, from: file, typeOnly: true, root: "models" }],
    schema: `z.lazy(() => ${name}Schema)`,
    schemaImports: [{ name: `${name}Schema`, from: file, typeOnly: false, root: "models" }],
    ...(codec ? { codec: true as const } : {}),
  };
}

/** A generated generic interface applied to `args`: `Page<Pet>`, validated by `PageSchema(PetSchema)`. */
export function genericDeclUse(name: string, file: string, args: readonly TsTypeUse[], codec = false): TsTypeUse {
  const base = declUse(name, file);
  return {
    text: `${name}<${args.map((a) => a.text).join(", ")}>`,
    imports: [...base.imports, ...args.flatMap((a) => a.imports)],
    schema: `z.lazy(() => ${name}Schema(${args.map((a) => a.schema).join(", ")}))`,
    schemaImports: [...base.schemaImports, ...args.flatMap((a) => a.schemaImports)],
    ...(codec ? { codec: true as const } : codecOf(args)),
  };
}

/** A type parameter inside a generic interface; its schema is the schema function's parameter. */
export function typeParamUse(name: string): TsTypeUse {
  return simple(name, `${name}Schema`);
}

function wrap(text: string): string {
  return / \| | & /.test(text) ? `(${text})` : text;
}

/** Strips `date` (see `dateUse`): true only when `text` renders exactly as the global `Date`, which wrapping breaks. */
function dropDate<T extends TsTypeUse>(use: T): Omit<T, "date"> {
  const { date: _date, ...rest } = use;
  return rest;
}

export function arrayOf(item: TsTypeUse): TsTypeUse {
  return { ...dropDate(item), text: `${wrap(item.text)}[]`, schema: `z.array(${item.schema})` };
}

export function recordOf(value: TsTypeUse): TsTypeUse {
  return { ...dropDate(value), text: `Record<string, ${value.text}>`, schema: `z.record(z.string(), ${value.schema})` };
}

export function nullable(type: TsTypeUse): TsTypeUse {
  return type.text.endsWith(" | null") ? type : { ...dropDate(type), text: `${type.text} | null`, schema: `${type.schema}.nullable()` };
}

export function unionOf(types: TsTypeUse[]): TsTypeUse {
  return {
    text: types.map((t) => t.text).join(" | "),
    imports: types.flatMap((t) => t.imports),
    schema: `z.union([${types.map((t) => t.schema).join(", ")}])`,
    schemaImports: types.flatMap((t) => t.schemaImports),
    ...codecOf(types),
  };
}

export interface ObjectField {
  key: string;
  type: TsTypeUse;
  optional: boolean;
}

/** `Page` + [`Pet`] → `Page<Pet>` with the imports of both; validated as an opaque custom type. */
export function genericOf(base: TsTypeUse, args: readonly TsTypeUse[]): TsTypeUse {
  const text = `${base.text}<${args.map((a) => a.text).join(", ")}>`;
  return {
    text,
    imports: [...base.imports, ...args.flatMap((a) => a.imports)],
    schema: `z.custom<${text}>()`,
    schemaImports: [],
  };
}

export function objectUse(fields: ObjectField[]): TsTypeUse {
  return {
    text: `{ ${fields.map((f) => `${f.key}${f.optional ? "?" : ""}: ${f.type.text}`).join("; ")} }`,
    imports: fields.flatMap((f) => f.type.imports),
    schema: `z.object({ ${fields.map((f) => `${f.key}: ${f.type.schema}${f.optional ? ".exactOptional()" : ""}`).join(", ")} })`,
    schemaImports: fields.flatMap((f) => f.type.schemaImports),
    ...codecOf(fields.map((f) => f.type)),
  };
}
