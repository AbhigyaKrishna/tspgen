import { buildApiIR } from "@abhigyakrishna/tspgen-core";
import { expectDiagnostics } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { transformToKotlin, type KotlinIR, type KtDecl } from "../src/transform/index.js";
import { Tester } from "./tester.js";

async function transform(code: string, enumMemberNaming: "UPPER_SNAKE" | "PascalCase" = "UPPER_SNAKE") {
  const [{ program }] = await Tester.compileAndDiagnose(code);
  const ir = transformToKotlin(program, buildApiIR(program), { package: "com.acme", enumMemberNaming });
  return { program, ir };
}

function decl(ir: KotlinIR, name: string): KtDecl {
  const found = ir.declarations.find((d) => d.name === name);
  if (!found) throw new Error(`no declaration ${name}: ${ir.declarations.map((d) => d.name).join(", ")}`);
  return found;
}

describe("transformToKotlin", () => {
  it("maps models to data classes with Kotlin types, defaults and serial names", async () => {
    const { ir } = await transform(`
      @service namespace S;
      model Pet {
        id: int64;
        name?: string;
        tags: string[];
        attrs: Record<int32>;
        @encodedName("application/json", "born_at") bornAt: utcDateTime;
        day: plainDate;
        color: Color = Color.red;
        weight?: float64 = 1.5;
        owner: Owner | null;
        meta: unknown;
      }
      model Owner { name: string }
      enum Color { red, darkBlue: "dark-blue" }
    `);
    const pet = decl(ir, "Pet");
    if (pet.kind !== "data-class") throw new Error("expected data class");
    expect(pet.package).toBe("com.acme.models");
    expect(pet.fqn).toBe("com.acme.models.Pet");
    expect(pet.properties.map((p) => [p.name, p.type.text, p.default, p.serialName])).toEqual([
      ["id", "Long", undefined, undefined],
      ["name", "String?", "null", undefined],
      ["tags", "List<String>", undefined, undefined],
      ["attrs", "Map<String, Int>", undefined, undefined],
      ["bornAt", "Instant", undefined, "born_at"],
      ["day", "LocalDate", undefined, undefined],
      ["color", "Color", "Color.RED", undefined],
      ["weight", "Double", "1.5", undefined],
      ["owner", "Owner?", undefined, undefined],
      ["meta", "JsonElement", undefined, undefined],
    ]);
    expect(pet.properties.find((p) => p.name === "bornAt")?.type.imports).toEqual(["kotlin.time.Instant"]);
    const color = decl(ir, "Color");
    expect(color).toMatchObject({
      kind: "enum",
      members: [
        { name: "RED", serialName: "red" },
        { name: "DARK_BLUE", serialName: "dark-blue" },
      ],
    });
  });

  it("maps discriminated models to a sealed interface with implementing data classes", async () => {
    const { ir } = await transform(`
      @service namespace Zoo;
      @discriminator("kind") model Animal { kind: string; name: string }
      model Dog extends Animal { kind: "dog"; bark: boolean }
    `);
    expect(decl(ir, "Animal")).toMatchObject({
      kind: "sealed-interface",
      discriminator: "kind",
      properties: [{ name: "name", type: { text: "String" } }],
    });
    const dog = decl(ir, "Dog");
    expect(dog).toMatchObject({ kind: "data-class", serialName: "dog", implements: ["com.acme.models.Animal"] });
    if (dog.kind !== "data-class") throw new Error();
    expect(dog.properties.map((p) => [p.name, p.override])).toEqual([
      ["name", true],
      ["bark", false],
    ]);
  });

  it("classifies unions", async () => {
    const { ir, program } = await transform(`
      @service namespace S;
      union Status { "active", "inactive" }
      union Loose { "a", string }
      model Cat { lives: int32 }
      model Dog { barks: boolean }
      @discriminated(#{ envelope: "none", discriminatorPropertyName: "type" })
      union Pet { cat: Cat, dog: Dog }
      union Mixed { Cat, int32 }
    `);
    expect(decl(ir, "Status")).toMatchObject({
      kind: "enum",
      members: [
        { name: "ACTIVE", serialName: "active" },
        { name: "INACTIVE", serialName: "inactive" },
      ],
    });
    expect(decl(ir, "Loose")).toMatchObject({ kind: "typealias", target: { text: "String" } });
    expect(decl(ir, "Pet")).toMatchObject({ kind: "sealed-interface", discriminator: "type" });
    expect(decl(ir, "Cat")).toMatchObject({ serialName: "cat", implements: ["com.acme.models.Pet"] });
    expect(decl(ir, "Mixed")).toMatchObject({ kind: "typealias", target: { text: "JsonElement" } });
    expectDiagnostics(program.diagnostics, [{ code: "@abhigyakrishna/tspgen-kotlin/unsupported-union" }]);
  });

  it("applies Kotlin decorators", async () => {
    const { ir } = await transform(`
      @service namespace S;
      @Kotlin.name("Customer") @Kotlin.annotate("@Suppress(\\"unused\\")")
      model User {
        @Kotlin.name("userId") id: string;
        @Kotlin.type("java.util.UUID") ref: string;
        at: ts;
      }
      @Kotlin.type("java.time.Instant") scalar ts extends utcDateTime;
      @Kotlin.packageName("com.acme.other") model Other { x: int32 }
      @Kotlin.type("com.acme.ext.Money") model Money { amount: string }
      model Wallet { balance: Money }
    `);
    const user = decl(ir, "Customer");
    if (user.kind !== "data-class") throw new Error();
    expect(user.annotations).toEqual([`@Suppress("unused")`]);
    expect(user.properties.map((p) => [p.name, p.serialName, p.type.text, p.type.imports])).toEqual([
      ["userId", "id", "String", []],
      ["ref", undefined, "UUID", ["java.util.UUID"]],
      ["at", undefined, "Instant", ["java.time.Instant"]],
    ]);
    expect(decl(ir, "Other").package).toBe("com.acme.other");
    expect(ir.declarations.find((d) => d.name === "Money")).toBeUndefined();
    const wallet = decl(ir, "Wallet");
    if (wallet.kind !== "data-class") throw new Error();
    expect(wallet.properties[0].type).toEqual({ text: "Money", imports: ["com.acme.ext.Money"], nullable: false });
  });

  it("maps numeric enums to typealiases with a warning and supports PascalCase members", async () => {
    const { ir, program } = await transform(
      `
      @service namespace S;
      enum Level { low: 1, high: 2 }
      enum Mode { fastMode, slow_mode }
    `,
      "PascalCase",
    );
    expect(decl(ir, "Level")).toMatchObject({ kind: "typealias", target: { text: "Int" } });
    expect(decl(ir, "Mode")).toMatchObject({ members: [{ name: "FastMode" }, { name: "SlowMode" }] });
    expectDiagnostics(program.diagnostics, [{ code: "@abhigyakrishna/tspgen-kotlin/numeric-enum" }]);
  });

  it("reports duplicate Kotlin type names", async () => {
    const { program } = await transform(`
      @service namespace S;
      model A { x: int32 }
      @Kotlin.name("A") model B { y: int32 }
    `);
    expectDiagnostics(program.diagnostics, [{ code: "@abhigyakrishna/tspgen-kotlin/duplicate-type-name" }]);
  });

  it("maps services, groups and operations", async () => {
    const { ir } = await transform(`
      @service namespace S;
      model Pet { id: int64 }
      @route("/pets") interface Pets {
        @get getPet(@path petId: int64, @query("page-size") pageSize?: int32, @header("x-trace") trace?: string): Pet;
        @post create(@body body: Pet, @query body2: string): { @statusCode _: 201; @header location: string };
      }
    `);
    const [service] = ir.services;
    expect(service).toMatchObject({ name: "S", package: "com.acme" });
    const [group] = service.groups;
    expect(group.name).toBe("Pets");
    const [getPet, create] = group.operations;
    expect(getPet.name).toBe("getPet");
    expect(getPet.params.map((p) => [p.name, p.wireName, p.location, p.type.text])).toEqual([
      ["petId", "petId", "path", "Long"],
      ["pageSize", "page-size", "query", "Int?"],
      ["trace", "x-trace", "header", "String?"],
    ]);
    expect(getPet.responses).toMatchObject([{ statusCodes: 200, body: { text: "Pet" }, contentType: "application/json" }]);
    expect(create.body).toMatchObject({ name: "body", type: { text: "Pet" }, contentType: "application/json" });
    expect(create.responses[0].headers).toMatchObject([{ name: "location", wireName: "location", type: { text: "String" } }]);
  });
});
