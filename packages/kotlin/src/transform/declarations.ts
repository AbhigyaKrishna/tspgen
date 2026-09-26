import type {
  ApiIR,
  DecoratorData,
  EnumIR,
  ModelIR,
  PropertyIR,
  TypeIR,
  TypeRef,
  UnionIR,
} from "@tspgen/emitter-core";
import { metaScopes, metaStrings, resolveMeta, type MetaScopes } from "@tspgen/emitter-core";
import { NoTarget, type Program } from "@typespec/compiler";
import { kotlinString } from "../kotlin-string.js";
import { reportDiagnostic, type EnumMemberNaming } from "../lib.js";
import { camel, identifier, typeName, upperSnake } from "../naming.js";
import { decoratorArg, decoratorArgs } from "./decorators.js";
import type { KtDataClass, KtDecl, KtEnumMember, KtProperty, KtTypeUse } from "./model.js";
import { mappedPackage } from "./packages.js";
import { fqnTypeUse, genericOf, JSON_ELEMENT, listOf, mapOf, nullable, scalarTypeUse } from "./type-map.js";

type UnionShape = "enum" | "string-alias" | "sealed-interface" | "json";

export interface DeclarationOptions {
  modelsPackage: string;
  enumMemberNaming: EnumMemberNaming;
  packages?: Record<string, string>;
  validation?: boolean;
}

const NUMERIC = new Set(["Byte", "Short", "Int", "Long", "Float", "Double"]);

function items(n: number): string {
  return `${n} ${n === 1 ? "item" : "items"}`;
}

function isEmptyObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

/** Builds Kotlin declarations for every IR type and resolves TypeRefs to Kotlin type uses. */
export class DeclarationBuilder {
  private readonly decls = new Map<string, KtDecl>();
  private readonly mapped = new Map<string, KtTypeUse>();
  /** Template instances mapped with @Kotlin.type: rendered as `<fqn><args>`. */
  private readonly generic = new Map<string, { fqn: string; args: TypeRef[] }>();
  private readonly types: Map<string, TypeIR>;
  /**
   * Per data-class decl id, the source PropertyIR by wire name — recorded in `fillModel` and
   * consulted only after sealed unions have removed discriminator properties, so validation
   * checks are never emitted for properties no longer on the class.
   */
  private readonly modelProps = new Map<string, Map<string, PropertyIR>>();

  constructor(
    private readonly program: Program,
    private readonly api: ApiIR,
    private readonly options: DeclarationOptions,
  ) {
    this.types = new Map(api.types.map((t) => [t.id, t]));
  }

  build(): KtDecl[] {
    for (const t of this.api.types) {
      const fqn = decoratorArg(t.decorators, "Kotlin.type");
      if (!fqn) continue;
      if (t.kind === "model" && t.templateArgs?.length) this.generic.set(t.id, { fqn, args: t.templateArgs });
      else this.mapped.set(t.id, fqnTypeUse(fqn));
    }
    const own = this.api.types.filter((t) => !this.mapped.has(t.id) && !this.generic.has(t.id));
    for (const t of own) this.decls.set(t.id, this.shell(t));
    // Enums (and enum-like unions) first so model defaults can reference members; sealed unions
    // last so they can adjust their variant data classes.
    for (const t of own) if (t.kind === "enum") this.fillEnum(t);
    for (const t of own) if (t.kind === "union" && this.unionShape(t) !== "sealed-interface") this.fillUnion(t);
    for (const t of own) if (t.kind === "model") this.fillModel(t);
    for (const t of own) if (t.kind === "union" && this.unionShape(t) === "sealed-interface") this.fillUnion(t);
    this.fillChecks();
    this.checkDuplicates();
    return [...this.decls.values()];
  }

  typeUse(ref: TypeRef): KtTypeUse {
    switch (ref.kind) {
      case "named": {
        const mapped = this.mapped.get(ref.id);
        if (mapped) return mapped;
        const generic = this.generic.get(ref.id);
        if (generic) return genericOf(fqnTypeUse(generic.fqn), generic.args.map((arg) => this.typeUse(arg)));
        const decl = this.decls.get(ref.id);
        return decl ? { text: decl.name, imports: [decl.fqn], nullable: false } : JSON_ELEMENT;
      }
      case "array":
        return listOf(this.typeUse(ref.of));
      case "map":
        return mapOf(this.typeUse(ref.of));
      case "scalar": {
        const fqn = decoratorArg(ref.custom?.decorators, "Kotlin.type");
        return fqn ? fqnTypeUse(fqn) : scalarTypeUse(ref.name);
      }
      case "literal":
        return scalarTypeUse(
          typeof ref.value === "string"
            ? "string"
            : typeof ref.value === "boolean"
              ? "boolean"
              : Number.isInteger(ref.value)
                ? "int32"
                : "float64",
        );
      case "nullable":
        return nullable(this.typeUse(ref.of));
      case "unknown":
        return JSON_ELEMENT;
    }
  }

  /** True if a model-level declaration already uses this simple name. */
  hasName(name: string): boolean {
    return [...this.decls.values()].some((d) => d.name === name);
  }

  /** Annotation lines: @Deprecated, @Kotlin.annotate and `annotations` from kotlin-scoped @meta. */
  annotations(
    item: { decorators: DecoratorData; deprecated?: string },
    where: string,
    scopes: MetaScopes = metaScopes(item.decorators),
  ): string[] {
    const list: string[] = [];
    if (item.deprecated) list.push(`@Deprecated(${kotlinString(item.deprecated)})`);
    list.push(...decoratorArgs(item.decorators, "Kotlin.annotate"));
    list.push(...metaStrings(this.program, resolveMeta(scopes, "kotlin"), "annotations", where));
    // Merged scopes concatenate arrays, so an annotation inherited from several levels repeats.
    return [...new Set(list)];
  }

  private shell(t: TypeIR): KtDecl {
    const name = decoratorArg(t.decorators, "Kotlin.name") ?? typeName(t.name);
    const pkg =
      decoratorArg(t.decorators, "Kotlin.packageName") ??
      mappedPackage(this.options.packages, t.namespace) ??
      this.options.modelsPackage;
    const scopes = metaScopes(t.decorators);
    const meta = resolveMeta(scopes, "kotlin");
    const implementsMeta = metaStrings(this.program, meta, "implements", t.id);
    const base = {
      id: t.id,
      name,
      package: pkg,
      fqn: `${pkg}.${name}`,
      ...(t.docs ? { docs: t.docs } : {}),
      annotations: this.annotations(t, t.id, scopes),
      meta: scopes,
      imports: metaStrings(this.program, meta, "imports", t.id),
    };
    switch (t.kind) {
      case "model":
        return t.discriminator
          ? { ...base, kind: "sealed-interface", discriminator: t.discriminator.property, properties: [], implements: [...implementsMeta] }
          : { ...base, kind: "data-class", properties: [], implements: [...implementsMeta], checks: [] };
      case "enum":
        return t.members.every((m) => typeof m.value === "string")
          ? { ...base, kind: "enum", members: [] }
          : { ...base, kind: "typealias", target: JSON_ELEMENT };
      case "union":
        switch (this.unionShape(t)) {
          case "enum":
            return { ...base, kind: "enum", members: [] };
          case "sealed-interface":
            return { ...base, kind: "sealed-interface", discriminator: t.discriminator!.property, properties: [], implements: [...implementsMeta] };
          default:
            return { ...base, kind: "typealias", target: JSON_ELEMENT };
        }
    }
  }

  private unionShape(u: UnionIR): UnionShape {
    const types = u.variants.map((v) => v.type);
    const stringLiterals = types.filter((t) => t.kind === "literal" && typeof t.value === "string").length;
    if (stringLiterals === types.length) return "enum";
    const strings = types.filter((t) => t.kind === "scalar" && t.name === "string").length;
    if (stringLiterals > 0 && stringLiterals + strings === types.length) return "string-alias";
    if (
      u.discriminator?.envelope === "none" &&
      types.every((t) => t.kind === "named" && this.types.get(t.id)?.kind === "model")
    ) {
      return "sealed-interface";
    }
    return "json";
  }

  private memberName(name: string): string {
    return this.options.enumMemberNaming === "PascalCase" ? typeName(name) : upperSnake(name);
  }

  private fillEnum(e: EnumIR): void {
    const decl = this.decls.get(e.id)!;
    if (decl.kind === "enum") {
      decl.members = e.members.map(
        (m): KtEnumMember => ({
          name: identifier(decoratorArg(m.decorators, "Kotlin.name") ?? this.memberName(m.name)),
          serialName: String(m.value),
          ...(m.docs ? { docs: m.docs } : {}),
          annotations: this.annotations(m, `${e.id}.${m.name}`),
          meta: metaScopes(m.decorators),
        }),
      );
      return;
    }
    if (decl.kind === "typealias") {
      const integers = e.members.every((m) => Number.isInteger(m.value));
      decl.target = scalarTypeUse(integers ? "int32" : "float64");
      reportDiagnostic(this.program, { code: "numeric-enum", format: { id: e.id, type: decl.target.text }, target: NoTarget });
    }
  }

  private fillUnion(u: UnionIR): void {
    const decl = this.decls.get(u.id)!;
    const shape = this.unionShape(u);
    if (decl.kind === "enum") {
      decl.members = u.variants.map((v) => {
        const value = v.type.kind === "literal" ? String(v.type.value) : "";
        return {
          name: identifier(this.memberName(v.name ?? value)),
          serialName: value,
          ...(v.docs ? { docs: v.docs } : {}),
          annotations: [],
          meta: {},
        };
      });
    } else if (decl.kind === "sealed-interface") {
      for (const variant of u.variants) {
        if (variant.type.kind !== "named") continue;
        const target = this.decls.get(variant.type.id);
        if (target?.kind !== "data-class") continue;
        target.implements.push(decl.fqn);
        if (target.serialName === undefined && variant.name) target.serialName = variant.name;
        target.properties = target.properties.filter((p) => p.wireName !== decl.discriminator);
      }
    } else if (decl.kind === "typealias") {
      if (shape === "string-alias") {
        decl.target = scalarTypeUse("string");
      } else {
        decl.target = JSON_ELEMENT;
        reportDiagnostic(this.program, { code: "unsupported-union", format: { id: u.id }, target: NoTarget });
      }
    }
  }

  private fillModel(model: ModelIR): void {
    const decl = this.decls.get(model.id)!;
    if (decl.kind === "sealed-interface") {
      decl.properties = model.properties
        .filter((p) => p.name !== model.discriminator?.property)
        .map((p) => this.property(p, false, model.id));
      return;
    }
    if (decl.kind !== "data-class") return;
    const chain = this.chain(model);
    const discriminators = new Set(chain.flatMap((m) => (m.discriminator ? [m.discriminator.property] : [])));
    const sealedBases = chain.slice(0, -1).filter((m) => m.discriminator && this.decls.get(m.id)?.kind === "sealed-interface");
    const abstractNames = new Set(sealedBases.flatMap((m) => m.properties.map((p) => p.name)));
    const byName = new Map<string, PropertyIR>();
    for (const m of chain) for (const p of m.properties) if (!discriminators.has(p.name)) byName.set(p.name, p);
    const props = [...byName.values()];
    decl.properties = props.map((p) => this.property(p, abstractNames.has(p.name), model.id));
    this.modelProps.set(model.id, new Map(props.map((p) => [p.wireName, p])));
    this.fillSealedParents(model, decl, sealedBases);
    if (chain.some((m) => m.additionalProperties)) {
      reportDiagnostic(this.program, { code: "additional-properties", format: { id: model.id }, target: NoTarget });
    }
  }

  /**
   * Fills `checks` on every data class, after sealed unions have removed discriminator
   * properties (`fillUnion` runs after `fillModel` for sealed interfaces) — so a check for a
   * property no longer on the class is never emitted. Property order first, then @meta lines.
   */
  private fillChecks(): void {
    for (const [id, byWireName] of this.modelProps) {
      const decl = this.decls.get(id);
      if (decl?.kind !== "data-class") continue;
      decl.checks = [
        ...(this.options.validation
          ? decl.properties.flatMap((prop) => {
              const p = byWireName.get(prop.wireName);
              return p ? this.checks(p, prop) : [];
            })
          : []),
        ...metaStrings(this.program, resolveMeta(decl.meta, "kotlin"), "checks", id),
      ];
    }
  }

  private fillSealedParents(model: ModelIR, decl: KtDataClass, sealedBases: ModelIR[]): void {
    for (const base of sealedBases) {
      decl.implements.push(this.decls.get(base.id)!.fqn);
      const value = Object.entries(base.discriminator!.mapping).find(([, id]) => id === model.id)?.[0];
      if (value !== undefined) decl.serialName = value;
    }
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

  private property(p: PropertyIR, override: boolean, owner: string): KtProperty {
    const name = identifier(decoratorArg(p.decorators, "Kotlin.name") ?? camel(p.name));
    const fqn = decoratorArg(p.decorators, "Kotlin.type");
    let type = fqn ? fqnTypeUse(fqn) : this.typeUse(p.type);
    const defaultValue = p.default !== undefined ? this.defaultLiteral(p.default, p.type, type) : undefined;
    if (p.optional && defaultValue === undefined) type = nullable(type);
    const prop: KtProperty = {
      name,
      wireName: p.wireName,
      type,
      override,
      ...(p.docs ? { docs: p.docs } : {}),
      annotations: this.annotations(p, `${owner}.${p.name}`),
      meta: metaScopes(p.decorators),
    };
    if (name.replace(/`/g, "") !== p.wireName) prop.serialName = p.wireName;
    if (defaultValue !== undefined) prop.default = defaultValue;
    else if (p.optional) prop.default = "null";
    return prop;
  }

  private checks(p: PropertyIR, prop: KtProperty): string[] {
    const c = p.constraints;
    if (!c) return [];
    const name = prop.name;
    const label = p.name;
    const base = prop.type.text.replace(/\?$/, "");
    const out: string[] = [];
    const add = (condition: string, message: string) => {
      const guarded = prop.type.nullable ? `${name} == null || ${condition}` : condition;
      out.push(`require(${guarded}) { ${kotlinString(message)} }`);
    };
    if (base === "String") {
      if (c.minLength === 1) add(`${name}.isNotBlank()`, `${label} must not be blank`);
      else if (c.minLength !== undefined) add(`${name}.length >= ${c.minLength}`, `${label} must be at least ${c.minLength} characters`);
      if (c.maxLength !== undefined) add(`${name}.length <= ${c.maxLength}`, `${label} must be at most ${c.maxLength} characters`);
      if (c.pattern !== undefined) add(`Regex(${kotlinString(c.pattern)}).containsMatchIn(${name})`, `${label} must match ${c.pattern}`);
    }
    if (base.startsWith("List<")) {
      if (c.minItems !== undefined) add(`${name}.size >= ${c.minItems}`, `${label} must have at least ${items(c.minItems)}`);
      if (c.maxItems !== undefined) add(`${name}.size <= ${c.maxItems}`, `${label} must have at most ${items(c.maxItems)}`);
    }
    if (NUMERIC.has(base)) {
      if (c.minValue !== undefined) add(`${name} >= ${c.minValue}`, `${label} must be at least ${c.minValue}`);
      if (c.maxValue !== undefined) add(`${name} <= ${c.maxValue}`, `${label} must be at most ${c.maxValue}`);
    }
    return out;
  }

  private defaultLiteral(value: unknown, ref: TypeRef, type: KtTypeUse): string | undefined {
    if (Array.isArray(value)) return value.length === 0 && ref.kind === "array" ? "emptyList()" : undefined;
    if (ref.kind === "map") return isEmptyObject(value) ? "emptyMap()" : undefined;
    if (ref.kind === "named") {
      const decl = this.decls.get(ref.id);
      // `#{}` for a model whose properties all have defaults (TypeSpec checks assignability).
      if (decl?.kind === "data-class") return isEmptyObject(value) ? `${decl.name}()` : undefined;
      if (decl?.kind === "enum") {
        const member = decl.members.find((m) => m.serialName === String(value));
        return member ? `${decl.name}.${member.name}` : undefined;
      }
      const mapped = this.mapped.get(ref.id);
      const source = this.types.get(ref.id);
      if (mapped && source?.kind === "enum") {
        const member = source.members.find((m) => String(m.value) === String(value));
        return member
          ? `${mapped.text}.${identifier(decoratorArg(member.decorators, "Kotlin.name") ?? this.memberName(member.name))}`
          : undefined;
      }
      return undefined;
    }
    if (typeof value === "string") return type.text === "String" ? kotlinString(value) : undefined;
    if (typeof value === "boolean") return String(value);
    if (typeof value !== "number") return undefined;
    switch (type.text) {
      case "Long":
        return `${value}L`;
      case "Float":
        return `${value}f`;
      case "Double":
        return Number.isInteger(value) ? `${value}.0` : String(value);
      case "Int":
      case "Short":
      case "Byte":
        return String(value);
      default:
        return undefined;
    }
  }

  private checkDuplicates(): void {
    const seen = new Map<string, string>();
    for (const decl of this.decls.values()) {
      const first = seen.get(decl.fqn);
      if (first) {
        reportDiagnostic(this.program, {
          code: "duplicate-type-name",
          format: { fqn: decl.fqn, first, second: decl.id },
          target: NoTarget,
        });
      } else {
        seen.set(decl.fqn, decl.id);
      }
    }
  }
}
