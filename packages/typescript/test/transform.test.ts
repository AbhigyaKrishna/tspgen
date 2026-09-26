import { buildApiIR } from "@abhigyakrishna/tspgen-core";
import { describe, expect, it } from "vitest";
import { transformToTs, type TsDecl, type TsIR } from "../src/transform/index.js";
import { Tester } from "./tester.js";

async function transform(code: string): Promise<TsIR> {
  const [{ program }] = await Tester.compileAndDiagnose(code);
  return transformToTs(program, buildApiIR(program), { zod: true, importExtension: "" });
}

function decl(ir: TsIR, name: string): TsDecl {
  const found = ir.declarations.find((d) => d.name === name);
  if (!found) throw new Error(`no declaration ${name}: ${ir.declarations.map((d) => d.name).join(", ")}`);
  return found;
}

describe("transformToTs", () => {
  it("maps models to interfaces with wire-name keys and zod schemas", async () => {
    const ir = await transform(`
      @service namespace S;
      model Pet {
        id: int64;
        name?: string;
        tags: string[];
        @encodedName("application/json", "born_at") bornAt: utcDateTime;
        owner: Owner | null;
        \`x-meta\`?: Record<unknown>;
        weight?: float64 = 1.5;
      }
      model Owner { name: string }
    `);
    const pet = decl(ir, "Pet");
    if (pet.kind !== "interface") throw new Error("expected interface");
    expect(pet.file).toBe("models/Pet");
    expect(pet.properties.map((p) => [p.key, p.optional, p.type.text, p.type.schema, p.defaultDoc])).toEqual([
      ["id", false, "number", "z.number().int()", undefined],
      ["name", true, "string", "z.string()", undefined],
      ["tags", false, "string[]", "z.array(z.string())", undefined],
      ["born_at", false, "string", "z.iso.datetime({ offset: true })", undefined],
      ["owner", false, "Owner | null", "z.lazy(() => OwnerSchema).nullable()", undefined],
      [`"x-meta"`, true, "Record<string, unknown>", "z.record(z.string(), z.unknown())", undefined],
      ["weight", true, "number", "z.number()", "1.5"],
    ]);
    expect(pet.properties[4].type.imports).toEqual([{ name: "Owner", from: "models/Owner", typeOnly: true }]);
    expect(pet.properties[4].type.schemaImports).toEqual([{ name: "OwnerSchema", from: "models/Owner", typeOnly: false }]);
  });

  it("maps enums and string-literal unions to enum declarations", async () => {
    const ir = await transform(`
      @service namespace S;
      enum Species { dog, cat, bird: "parrot" }
      enum Level { low: 1, high: 2 }
      union Status { "active", "inactive" }
      union Loose { "a", string }
    `);
    expect(decl(ir, "Species")).toMatchObject({
      kind: "enum",
      members: [
        { name: "Dog", value: "dog" },
        { name: "Cat", value: "cat" },
        { name: "Bird", value: "parrot" },
      ],
    });
    expect(decl(ir, "Level")).toMatchObject({ kind: "enum", members: [{ name: "Low", value: 1 }, { name: "High", value: 2 }] });
    expect(decl(ir, "Status")).toMatchObject({ kind: "enum", members: [{ name: "Active", value: "active" }, { name: "Inactive", value: "inactive" }] });
    expect(decl(ir, "Loose")).toMatchObject({ kind: "alias", type: { text: `"a" | (string & {})`, schema: "z.string()" } });
  });

  it("maps discriminated models and unions to TS discriminated unions", async () => {
    const ir = await transform(`
      @service namespace S;
      @discriminator("kind") model Toy { kind: string; name: string }
      model Ball extends Toy { kind: "ball"; diameter: float32 }
      model Rope extends Toy { kind: "rope"; length: int32 }
      model Cat { lives: int32 }
      model Dog { barks: boolean }
      @discriminated(#{ envelope: "none", discriminatorPropertyName: "type" })
      union Pet { cat: Cat, dog: Dog }
      @discriminated union Wrapped { cat: Cat, dog: Dog }
      union Mixed { Cat, int32 }
    `);
    expect(decl(ir, "Toy")).toMatchObject({ kind: "alias", type: { text: "Ball | Rope" } });
    const ball = decl(ir, "Ball");
    if (ball.kind !== "interface") throw new Error();
    expect(ball.properties.map((p) => [p.key, p.type.text])).toEqual([
      ["kind", `"ball"`],
      ["name", "string"],
      ["diameter", "number"],
    ]);
    expect(decl(ir, "Pet")).toMatchObject({ kind: "alias", type: { text: "Cat | Dog" } });
    const cat = decl(ir, "Cat");
    if (cat.kind !== "interface") throw new Error();
    expect(cat.properties.map((p) => [p.key, p.type.text])).toEqual([
      ["type", `"cat"`],
      ["lives", "number"],
    ]);
    expect(decl(ir, "Wrapped")).toMatchObject({
      kind: "alias",
      type: { text: `{ kind: "cat"; value: Cat } | { kind: "dog"; value: Dog }` },
    });
    expect(decl(ir, "Mixed")).toMatchObject({ kind: "alias", type: { text: "Cat | number" } });
  });

  it("applies TS decorators", async () => {
    const ir = await transform(`
      @service namespace S;
      @TS.name("Customer") model User { @TS.type("Decimal", "decimal.js") balance: string; at: ts; }
      @TS.type("Date") scalar ts extends utcDateTime;
      @TS.type("Money", "@acme/money") model Money { amount: string }
      model Wallet { balance: Money }
    `);
    const user = decl(ir, "Customer");
    if (user.kind !== "interface") throw new Error();
    expect(user.properties.map((p) => [p.key, p.type.text, p.type.imports])).toEqual([
      ["balance", "Decimal", [{ name: "Decimal", from: "decimal.js", typeOnly: true, external: true }]],
      ["at", "Date", []],
    ]);
    expect(ir.declarations.find((d) => d.name === "Money")).toBeUndefined();
    const wallet = decl(ir, "Wallet");
    if (wallet.kind !== "interface") throw new Error();
    expect(wallet.properties[0].type).toMatchObject({ text: "Money", schema: "z.custom<Money>()" });
  });

  it("builds services with results and error classes", async () => {
    const ir = await transform(`
      @service namespace PetStore;
      model Pet { id: int64 }
      @error model ApiError { code: string }
      @error model NotFound { @statusCode _: 404; message: string }
      @route("/pets") interface Pets {
        @get get(@path petId: int64, @query("page-size") pageSize?: int32): Pet | NotFound | ApiError;
        @post create(@body pet: Pet): { @statusCode _: 201; @header location: string; @body pet: Pet } | { @statusCode _: 200; @body pet: Pet };
        @delete remove(@path petId: int64): void;
      }
    `);
    const [get, create, remove] = ir.services[0].groups[0].operations;
    expect(ir.services[0]).toMatchObject({ name: "PetStore", groups: [{ name: "Pets" }] });
    expect(get.params.map((p) => [p.name, p.wireName, p.location, p.type.text, p.optional])).toEqual([
      ["petId", "petId", "path", "number", false],
      ["pageSize", "page-size", "query", "number", true],
    ]);
    expect(get.result).toMatchObject({ kind: "single", status: 200, type: { text: "Pet" } });
    expect(get.errors.map((e) => [e.statusCodes, e.errorClass.text])).toEqual([
      [404, "NotFoundError"],
      ["default", "ApiErrorError"],
    ]);
    expect(create.body).toMatchObject({ name: "pet", contentType: "application/json", optional: false });
    expect(create.result).toMatchObject({
      kind: "union",
      type: { text: "CreateResult", imports: [{ name: "CreateResult", from: "api/results", typeOnly: true }] },
      decl: {
        variants: [
          { status: 201, body: { text: "Pet" }, headers: [{ name: "location", wireName: "location" }] },
          { status: 200, body: { text: "Pet" }, headers: [] },
        ],
      },
    });
    expect(remove.result).toMatchObject({ kind: "single", status: 204, type: { text: "void" } });
    expect(ir.errorClasses.map((e) => e.name)).toEqual(["NotFoundError", "ApiErrorError"]);
    expect(ir.results.map((r) => r.name)).toEqual(["CreateResult"]);
    expect(ir.apiActive).toBe(true);
  });
});
