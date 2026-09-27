import {
  decoratorArg,
  metaBoolean,
  metaObjects,
  metaScopes,
  metaStrings,
  reportDiagnostic as reportCoreDiagnostic,
  resolveMeta,
  type MetaData,
  type ApiIR,
  type DecoratorData,
  type EnumIR,
  type ModelIR,
  type PropertyIR,
  type StreamIR,
  type TypeIR,
  type TypeRef,
  type UnionIR,
} from "@abhigyakrishna/tspgen-core";
import { NoTarget, type Program } from "@typespec/compiler";
import { reportDiagnostic } from "../lib.js";
import { memberName, propertyKey, RESERVED_WORDS, typeName } from "../naming.js";
import { constrain } from "./constraints.js";
import type { TsDecl, TsEnumMember, TsEvent, TsInterface, TsProperty, TsStream, TsTypeUse } from "./model.js";
import {
  arrayOf,
  declUse,
  externalUse,
  FILE,
  genericDeclUse,
  genericOf,
  literalUse,
  nullable,
  objectUse,
  recordOf,
  scalarUse,
  simple,
  typeParamUse,
  unionOf,
  UNKNOWN,
} from "./type-map.js";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** `@TS.type(name, module?)` override, if applied. */
export function typeOverride(decorators: DecoratorData | undefined): TsTypeUse | undefined {
  const args = decorators?.["TS.type"]?.at(-1);
  if (!args || typeof args[0] !== "string") return undefined;
  return externalUse(args[0], typeof args[1] === "string" ? args[1] : undefined, true);
}

export interface DeclarationOptions {
  layout?: "per-type" | "single-file";
  /** zod schemas are emitted; unparsable `@pattern`s are only reported then. */
  zod?: boolean;
}

/** Builds TS declarations for every IR type and resolves TypeRefs to TS type uses. */
export class DeclarationBuilder {
  private readonly decls = new Map<string, TsDecl>();
  private readonly mapped = new Map<string, TsTypeUse>();
  /** Template instances mapped with @TS.type: rendered as `<name><args>`. */
  private readonly generic = new Map<string, { base: TsTypeUse; args: TypeRef[] }>();
  private readonly types: Map<string, TypeIR>;
  private sseMessageDecl: TsInterface | undefined;

  constructor(
    private readonly program: Program,
    private readonly api: ApiIR,
    private readonly options: DeclarationOptions = {},
  ) {
    this.types = new Map(api.types.map((t) => [t.id, t]));
  }

  build(): TsDecl[] {
    for (const t of this.api.types) {
      const override = typeOverride(t.decorators);
      if (!override) continue;
      if (t.kind === "model" && t.templateArgs?.length) this.generic.set(t.id, { base: override, args: t.templateArgs });
      else this.mapped.set(t.id, override);
    }
    const own = this.api.types.filter((t) => !this.mapped.has(t.id) && !this.generic.has(t.id));
    for (const t of own) this.decls.set(t.id, this.shell(t));
    for (const t of own) if (t.kind === "enum") this.fillEnum(t);
    for (const t of own) if (t.kind === "model") this.fillModel(t);
    for (const t of own) if (t.kind === "union") this.fillUnion(t);
    this.checkDuplicates();
    return [...this.decls.values()];
  }

  /** `SseMessage`, the element of untyped event streams, once some operation streams them. */
  get sseMessage(): TsInterface | undefined {
    return this.sseMessageDecl;
  }

  /** The TypeScript side of a response stream whose body type is `ref`: its events union, else `SseMessage`. */
  stream(stream: StreamIR, ref: TypeRef): TsStream {
    const id = stream.events && ref.kind === "named" ? ref.id : undefined;
    const union = id ? this.types.get(id) : undefined;
    if (id && union?.kind === "union" && union.events && this.decls.has(id)) {
      return {
        type: this.typeUse(ref),
        events: union.events.map((e): TsEvent => {
          const json = /[/+]json(;|$)/.test(e.contentType);
          const payload = this.typeUse(e.payload);
          const data = json ? "json" : payload.text === "number" ? "number" : payload.text === "boolean" ? "boolean" : "text";
          const literal = e.payload.kind === "literal" ? e.payload.value : undefined;
          return {
            event: e.name,
            data,
            ...(literal !== undefined ? { literal: json ? JSON.stringify(literal) : String(literal), value: literal } : {}),
            terminal: e.terminal,
          };
        }),
      };
    }
    this.sseMessageDecl ??= {
      kind: "interface",
      id: "$sse.SseMessage",
      name: "SseMessage",
      file: this.options.layout === "single-file" ? "types" : "models/SseMessage",
      namespace: [],
      docs: "One server-sent event of an untyped event stream.",
      meta: {},
      jsdoc: [],
      extends: [],
      properties: [
        { key: "event", wireName: "event", type: simple("string", "z.string()"), optional: true, docs: 'The `event:` name; absent for the default "message" type.', meta: {}, readonly: false, jsdoc: [] },
        { key: "data", wireName: "data", type: simple("string", "z.string()"), optional: false, docs: 'The `data:` lines, joined with "\\n".', meta: {}, readonly: false, jsdoc: [] },
        { key: "id", wireName: "id", type: simple("string", "z.string()"), optional: true, docs: "The last `id:`.", meta: {}, readonly: false, jsdoc: [] },
      ],
    };
    return { type: declUse("SseMessage", this.sseMessageDecl.file) };
  }

  /** Wire name (the TS object key) of property `name` of model `modelId`; `name` when unknown. */
  propertyWireName(modelId: string, name: string): string {
    const model = this.types.get(modelId);
    return (model?.kind === "model" ? model.properties.find((p) => p.name === name)?.wireName : undefined) ?? name;
  }

  hasName(name: string): boolean {
    return [...this.decls.values()].some((d) => d.name === name);
  }

  typeUse(ref: TypeRef): TsTypeUse {
    switch (ref.kind) {
      case "named": {
        const generic = this.generic.get(ref.id);
        if (generic) return genericOf(generic.base, generic.args.map((arg) => this.typeUse(arg)));
        const args = ref.args?.map((arg) => this.typeUse(arg)) ?? [];
        const mapped = this.mapped.get(ref.id);
        if (mapped) return args.length > 0 ? genericOf(mapped, args) : mapped;
        const decl = this.decls.get(ref.id);
        if (!decl) return UNKNOWN;
        return args.length > 0 ? genericDeclUse(decl.name, decl.file, args) : declUse(decl.name, decl.file);
      }
      case "typeParam":
        return typeParamUse(ref.name);
      case "array":
        return arrayOf(this.typeUse(ref.of));
      case "map":
        return recordOf(this.typeUse(ref.of));
      case "scalar":
        return typeOverride(ref.custom?.decorators) ?? scalarUse(ref.name);
      case "literal":
        return literalUse(ref.value);
      case "nullable":
        return nullable(this.typeUse(ref.of));
      case "file":
        return FILE;
      case "unknown":
        return UNKNOWN;
    }
  }

  private shell(t: TypeIR): TsDecl {
    const name = decoratorArg(t.decorators, "TS.name") ?? typeName(t.name);
    const scopes = metaScopes(t.decorators);
    const meta = resolveMeta(scopes, "typescript");
    const base = {
      id: t.id,
      name,
      file: this.options.layout === "single-file" ? "types" : `models/${name}`,
      namespace: t.namespace,
      ...(t.docs ? { docs: t.docs } : {}),
      ...(t.deprecated ? { deprecated: t.deprecated } : {}),
      meta: scopes,
      jsdoc: metaStrings(this.program, meta, "jsdoc", t.id),
    };
    if (t.kind === "enum" || (t.kind === "union" && !t.events && this.isStringLiteralUnion(t))) {
      const [values] = metaStrings(this.program, meta, "values", t.id);
      const validValues =
        values && IDENTIFIER.test(values) && values !== name && !RESERVED_WORDS.has(values) ? values : undefined;
      if (values && !validValues) {
        reportCoreDiagnostic(this.program, {
          code: "invalid-meta",
          format: { key: "values", where: t.id, expected: "an identifier different from the enum name or a reserved word" },
          target: NoTarget,
        });
      }
      return { ...base, kind: "enum", members: [], ...(validValues ? { values: validValues } : {}) };
    }
    if (t.kind === "model" && !(t.discriminator && Object.keys(t.discriminator.mapping).length > 0)) {
      return {
        ...base,
        kind: "interface",
        properties: [],
        extends: this.extendsOf(meta, t.id),
        ...(t.typeParameters?.length ? { typeParameters: t.typeParameters } : {}),
      };
    }
    return { ...base, kind: "alias", type: UNKNOWN };
  }

  private extendsOf(meta: MetaData, where: string): TsTypeUse[] {
    return metaObjects(this.program, meta, "supertypes", where).flatMap((entry) =>
      typeof entry.name === "string"
        ? [externalUse(entry.name, typeof entry.from === "string" ? entry.from : undefined)]
        : [],
    );
  }

  private isStringLiteralUnion(u: UnionIR): boolean {
    return u.variants.every((v) => v.type.kind === "literal" && typeof v.type.value === "string");
  }

  private fillEnum(e: EnumIR): void {
    const decl = this.decls.get(e.id)!;
    if (decl.kind !== "enum") return;
    decl.members = e.members.map(
      (m): TsEnumMember => ({
        name: decoratorArg(m.decorators, "TS.name") ?? memberName(m.name),
        value: m.value,
        ...(m.docs ? { docs: m.docs } : {}),
        meta: metaScopes(m.decorators),
      }),
    );
  }

  private fillModel(model: ModelIR): void {
    const decl = this.decls.get(model.id)!;
    if (decl.kind === "alias") {
      const ids = [...new Set(Object.values(model.discriminator!.mapping))];
      decl.type = unionOf(ids.map((id) => this.typeUse({ kind: "named", id })));
      return;
    }
    if (decl.kind !== "interface") return;
    const byName = new Map<string, PropertyIR>();
    for (const m of this.chain(model)) for (const p of m.properties) byName.set(p.name, p);
    const readonly = metaBoolean(this.program, resolveMeta(decl.meta, "typescript"), "readonly", model.id) ?? false;
    decl.properties = [...byName.values()].map((p) => this.property(p, readonly, model.id));
    for (const base of this.chain(model).slice(0, -1)) {
      if (!base.discriminator) continue;
      const value = Object.entries(base.discriminator.mapping).find(([, id]) => id === model.id)?.[0];
      if (value !== undefined) this.inject(model.id, base.discriminator.property, value);
    }
  }

  private fillUnion(u: UnionIR): void {
    const decl = this.decls.get(u.id)!;
    if (u.events && decl.kind === "alias") {
      decl.type = this.eventsUse(u);
      return;
    }
    if (decl.kind === "enum") {
      decl.members = u.variants.map((v) => {
        const value = v.type.kind === "literal" ? String(v.type.value) : "";
        return { name: memberName(v.name ?? value), value, ...(v.docs ? { docs: v.docs } : {}), meta: {} };
      });
      return;
    }
    if (decl.kind !== "alias") return;
    const types = u.variants.map((v) => v.type);
    const literals = types.filter((t) => t.kind === "literal" && typeof t.value === "string");
    const strings = types.filter((t) => t.kind === "scalar" && t.name === "string");
    if (literals.length > 0 && literals.length + strings.length === types.length) {
      decl.type = simple(`${literals.map((t) => this.typeUse(t).text).join(" | ")} | (string & {})`, "z.string()");
      return;
    }
    const disc = u.discriminator;
    if (disc?.envelope === "object") {
      decl.type = unionOf(
        u.variants.map((v, i) =>
          objectUse([
            { key: propertyKey(disc.property), type: literalUse(v.name ?? String(i)), optional: false },
            { key: propertyKey(disc.envelopeProperty), type: this.typeUse(v.type), optional: false },
          ]),
        ),
      );
      return;
    }
    if (disc) {
      for (const v of u.variants) if (v.name && v.type.kind === "named") this.inject(v.type.id, disc.property, v.name);
    }
    decl.type = unionOf(types.map((t) => this.typeUse(t)));
  }

  /**
   * An `@events` union: `{ event: "<name>"; data: <payload> }` per event, one per line; a discriminated zod union
   * unless event names repeat (unnamed variants are all "message").
   */
  private eventsUse(u: UnionIR): TsTypeUse {
    const variants = (u.events ?? []).map((e) =>
      objectUse([
        { key: "event", type: literalUse(e.name), optional: false },
        { key: "data", type: this.typeUse(e.payload), optional: false },
      ]),
    );
    if (variants.length === 0) return simple("never", "z.never()");
    const union = unionOf(variants);
    const names = (u.events ?? []).map((e) => e.name);
    return {
      ...union,
      text: variants.map((v) => `\n  | ${v.text}`).join(""),
      schema:
        new Set(names).size === names.length
          ? `z.discriminatedUnion("event", [${variants.map((v) => v.schema).join(", ")}])`
          : union.schema,
    };
  }

  /** Ensure a variant interface declares the discriminator as a literal property. */
  private inject(modelId: string, property: string, value: string): void {
    const decl = this.decls.get(modelId);
    if (decl?.kind !== "interface") return;
    const existing = decl.properties.find((p) => p.wireName === property);
    if (existing) {
      existing.type = literalUse(value);
      return;
    }
    decl.properties.unshift({
      key: propertyKey(property),
      wireName: property,
      type: literalUse(value),
      optional: false,
      meta: {},
      readonly: false,
      jsdoc: [],
    });
  }

  private chain(model: ModelIR): ModelIR[] {
    const chain: ModelIR[] = [];
    let current: ModelIR | undefined = model;
    while (current) {
      chain.unshift(current);
      const base: TypeIR | undefined = current.baseId ? this.types.get(current.baseId) : undefined;
      current = base?.kind === "model" ? base : undefined;
    }
    return chain;
  }

  private property(p: PropertyIR, modelReadonly: boolean, owner: string): TsProperty {
    const scopes = metaScopes(p.decorators);
    const meta = resolveMeta(scopes, "typescript");
    const where = `${owner}.${p.name}`;
    return {
      key: propertyKey(p.wireName),
      wireName: p.wireName,
      type: constrain(
        typeOverride(p.decorators) ?? this.typeUse(p.type),
        p.constraints,
        metaBoolean(this.program, meta, "notBlank", where) === true,
        (pattern) => this.invalidPattern(pattern, where),
      ),
      optional: p.optional,
      readonly: metaBoolean(this.program, meta, "readonly", where) ?? modelReadonly,
      jsdoc: metaStrings(this.program, meta, "jsdoc", where),
      meta: scopes,
      ...(p.docs ? { docs: p.docs } : {}),
      ...(p.deprecated ? { deprecated: p.deprecated } : {}),
      ...(p.default !== undefined ? { defaultDoc: JSON.stringify(p.default) } : {}),
    };
  }

  /** Warns that a `@pattern` is not a JavaScript regular expression (so zod does not check it). */
  invalidPattern(pattern: string, where: string): void {
    if (!this.options.zod) return;
    reportDiagnostic(this.program, { code: "invalid-pattern", format: { pattern, where }, target: NoTarget });
  }

  private checkDuplicates(): void {
    const seen = new Map<string, string>();
    for (const decl of this.decls.values()) {
      const first = seen.get(decl.name);
      if (first) {
        reportDiagnostic(this.program, {
          code: "duplicate-type-name",
          format: { name: decl.name, first, second: decl.id },
          target: NoTarget,
        });
      } else {
        seen.set(decl.name, decl.id);
      }
    }
  }
}
