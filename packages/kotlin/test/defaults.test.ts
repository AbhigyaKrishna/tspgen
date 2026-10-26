import type { ModelIR, PropertyIR, TypeIR, TypeRef } from "@abhigyakrishna/tspgen-core";
import { describe, expect, it } from "vitest";
import { renderDefault, type DefaultContext } from "../src/transform/defaults.js";
import type { KtDataClass, KtDecl, KtEnum, KtTypeUse } from "../src/transform/model.js";
import { fqnTypeUse, genericOf, JSON_ELEMENT, listOf, mapOf, nullable, scalarTypeUse } from "../src/transform/type-map.js";

const scalar = (name: string): TypeRef => ({ kind: "scalar", name });
const named = (id: string): TypeRef => ({ kind: "named", id });
const base = (name: string) => ({ id: name, name, package: "com.acme", fqn: `com.acme.${name}`, annotations: [], meta: {}, imports: [] });
const property = (name: string, type: TypeRef, wireName = name): PropertyIR => ({ name, wireName, type, optional: false, decorators: {} });
const model = (name: string, properties: PropertyIR[]): ModelIR => ({ kind: "model", id: name, name, namespace: [], decorators: {}, properties });
const dataClass = (name: string): KtDataClass => ({ ...base(name), kind: "data-class", properties: [], implements: [], checks: [] });

function context(sources: TypeIR[] = [], declarations: KtDecl[] = []): DefaultContext {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const declarationById = new Map(declarations.map((declaration) => [declaration.id, declaration]));
  const typeUse = (ref: TypeRef): KtTypeUse => {
    switch (ref.kind) {
      case "scalar": return scalarTypeUse(ref.name, "java.time");
      case "array": return listOf(typeUse(ref.of));
      case "map": return mapOf(typeUse(ref.of));
      case "nullable": return nullable(typeUse(ref.of));
      case "named": {
        const type = fqnTypeUse(`com.acme.${ref.id}`);
        return ref.args?.length ? genericOf(type, ref.args.map(typeUse)) : type;
      }
      case "typeParam": return { text: ref.name, nullable: false, imports: [] };
      case "unknown": return JSON_ELEMENT;
      case "literal": return scalarTypeUse(typeof ref.value === "number" ? "int32" : typeof ref.value === "boolean" ? "boolean" : "string");
      default: throw new Error(`No test mapping for ${ref.kind}`);
    }
  };
  return {
    source: (id) => sourceById.get(id),
    declaration: (id) => declarationById.get(id),
    typeUse,
    propertyName: (_id, name) => name,
  };
}

describe("Kotlin default values", () => {
  it("retains legacy primitive expressions and scalar wrappers", () => {
    const ctx = context();
    for (const [value, name, expected] of [
      [3, "int64", "3L"], [3, "uint64", "3uL"], [3, "float32", "3f"],
      [3, "float64", "3.0"], [3.5, "float64", "3.5"], [3, "int32", "3"],
      [1.25, "decimal", 'BigDecimal("1.25")'], [true, "boolean", "true"],
      ["a\"$b", "string", '"a\\\"\\$b"'],
    ] as const) {
      expect(renderDefault(value, scalar(name), scalarTypeUse(name), ctx)).toBe(expected);
    }
    const wrapper: KtTypeUse = { text: "Code?", imports: ["com.acme.Code"], nullable: true,
      wrapper: "value-class", underlying: scalarTypeUse("string") };
    expect(renderDefault("abc", scalar("string"), wrapper, ctx)).toBe('Code("abc")');
  });

  it("renders nonempty collections recursively and retains empty constructor expressions", () => {
    const ref: TypeRef = { kind: "array", of: { kind: "map", of: scalar("int64") } };
    const ctx = context();
    expect(renderDefault([{ first: 1 }, { second: 2 }], ref, ctx.typeUse(ref), ctx))
      .toBe('listOf(mapOf("first" to 1L), mapOf("second" to 2L))');
    expect(renderDefault([], ref, ctx.typeUse(ref), ctx)).toBe("emptyList()");
    const map: TypeRef = { kind: "map", of: scalar("string") };
    expect(renderDefault({}, map, ctx.typeUse(map), ctx)).toBe("emptyMap()");
    expect(renderDefault([1, {}], { kind: "array", of: scalar("int32") }, listOf(scalarTypeUse("int32")), ctx))
      .toBeUndefined();
  });

  it("renders nested model constructors using wire keys and named Kotlin properties", () => {
    const person = model("Person", [{ ...property("displayName", scalar("string"), "display_name"), default: "Pat" }]);
    const receipt = model("Receipt", [property("owner", named("Person"))]);
    const ctx = context([person, receipt], [dataClass("Person"), dataClass("Receipt")]);
    ctx.propertyName = (id, name) => id === "Person" && name === "displayName" ? "label" : name;
    expect(renderDefault({ owner: { display_name: "Pat" } }, named("Receipt"), ctx.typeUse(named("Receipt")), ctx))
      .toBe('Receipt(owner = com.acme.Person(label = "Pat"))');
    expect(renderDefault({}, named("Person"), ctx.typeUse(named("Person")), ctx)).toBe("Person()");
  });

  it("substitutes generic model arguments inside nested properties", () => {
    const box = model("Box", [property("values", { kind: "array", of: { kind: "typeParam", name: "T" } })]);
    box.typeParameters = ["T"];
    const ctx = context([box], [dataClass("Box")]);
    const ref: TypeRef = { kind: "named", id: "Box", args: [scalar("int64")] };
    expect(renderDefault({ values: [1, 2] }, ref, ctx.typeUse(ref), ctx))
      .toBe("Box<Long>(values = listOf(1L, 2L))");
  });

  it("retains generated and mapped enum names, including numeric JSON values", () => {
    const kind: KtEnum = { ...base("Kind"), kind: "enum", members: [
      { name: "CAT", serialName: "cat", annotations: [], meta: {} },
      { name: "ONE", serialName: "1", value: 1, annotations: [], meta: {} },
    ] };
    const source: TypeIR = { kind: "enum", id: "External", name: "External", namespace: [], decorators: {},
      members: [{ name: "goodCat", value: "cat", decorators: {} }] };
    const ctx = context([source], [kind]);
    expect(renderDefault("cat", named("Kind"), ctx.typeUse(named("Kind")), ctx)).toBe("Kind.CAT");
    expect(renderDefault(1, named("Kind"), ctx.typeUse(named("Kind")), ctx)).toBe("Kind.ONE");
    ctx.enumMemberName = () => "GoodCat";
    expect(renderDefault("cat", named("External"), fqnTypeUse("external.Kind"), ctx)).toBe("Kind.GoodCat");
  });

  it("renders null values and nested optional nullable presence wrappers", () => {
    const nullableString: TypeRef = { kind: "nullable", of: scalar("string") };
    const patch = model("Patch", [{ ...property("label", nullableString), optional: true }]);
    const ctx = context([patch], [dataClass("Patch")]);
    expect(renderDefault(null, nullableString, ctx.typeUse(nullableString), ctx)).toBe("null");
    expect(renderDefault("Pat", nullableString, ctx.typeUse(nullableString), ctx)).toBe('"Pat"');
    expect(renderDefault(null, { kind: "literal", value: null }, JSON_ELEMENT, ctx)).toBe("kotlinx.serialization.json.JsonNull");
    ctx.optionalValue = "com.acme.OptionalValue";
    expect(renderDefault({ label: null }, named("Patch"), ctx.typeUse(named("Patch")), ctx))
      .toBe("Patch(label = com.acme.OptionalValue.Present(null))");
  });

  it("renders date/time defaults and exact string-encoded integer defaults", () => {
    const ctx = context();
    expect(renderDefault("2026-10-26T00:00:00Z", scalar("utcDateTime"), scalarTypeUse("utcDateTime", "java.time"), ctx))
      .toBe('java.time.Instant.parse("2026-10-26T00:00:00Z")');
    expect(renderDefault("PT30S", scalar("duration"), scalarTypeUse("duration", "kotlin.time"), ctx))
      .toBe('kotlin.time.Duration.parseIsoString("PT30S")');
    expect(renderDefault("18446744073709551615", { kind: "scalar", name: "uint64", encoding: "string" }, scalarTypeUse("uint64"), ctx))
      .toBe("18446744073709551615uL");
    expect(renderDefault("-9223372036854775808", scalar("int64"), scalarTypeUse("int64"), ctx)).toBe("Long.MIN_VALUE");
    expect(renderDefault("18446744073709551616", scalar("uint64"), scalarTypeUse("uint64"), ctx)).toBeUndefined();
  });

  it("preserves additional model properties and positional tuple defaults", () => {
    const open = model("Open", [property("known", scalar("string"))]);
    open.additionalProperties = scalar("int64");
    const declaration = dataClass("Open");
    declaration.additional = { name: "extras", type: mapOf(scalarTypeUse("int64")) };
    const pair = Object.assign(model("Pair", [property("item1", scalar("string")), property("item2", scalar("int64"))]), { tuple: true });
    const ctx = context([open, pair], [declaration, dataClass("Pair")]);
    expect(renderDefault({ known: "x", extra: 3 }, named("Open"), ctx.typeUse(named("Open")), ctx))
      .toBe('Open(known = "x", extras = mapOf("extra" to 3L))');
    expect(renderDefault(["x", 3], named("Pair"), ctx.typeUse(named("Pair")), ctx))
      .toBe('Pair(item1 = "x", item2 = 3L)');
    expect(renderDefault(["x"], named("Pair"), ctx.typeUse(named("Pair")), ctx)).toBeUndefined();
  });

  it("represents unknown JSON defaults without guessing opaque mapped constructors", () => {
    const source = model("Mapped", [property("id", scalar("string"))]);
    const ctx = context([source], [dataClass("Mapped")]);
    expect(renderDefault({ items: [1, null] }, { kind: "unknown" }, JSON_ELEMENT, ctx))
      .toBe('kotlinx.serialization.json.Json.parseToJsonElement("{\\"items\\":[1,null]}")');
    expect(renderDefault("id", scalar("string"), fqnTypeUse("java.util.UUID"), ctx)).toBeUndefined();
    expect(renderDefault({ id: "x" }, named("Mapped"), fqnTypeUse("external.Custom"), ctx)).toBeUndefined();
  });
});
