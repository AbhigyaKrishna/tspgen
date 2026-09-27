import { expectDiagnostics } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { modelsPrefix, renderImports } from "../src/imports.js";
import { emitter, HEADER } from "./tester.js";

const spec = `
  @service namespace PetStore;
  /** A pet */
  model Pet {
    id: int64;
    name?: string;
    tags: string[];
    @encodedName("application/json", "born_at") bornAt: utcDateTime;
    species: Species;
    weight?: float64 = 1.5;
    owner: Owner | null;
    \`x-meta\`?: Record<unknown>;
  }
  model Owner { name: string }
  enum Species { dog, cat, bird: "parrot" }
  @discriminator("kind") model Toy { kind: string; name: string }
  model Ball extends Toy { kind: "ball"; diameter: float32 }
  model Rope extends Toy { kind: "rope"; length: int32 }
`;

const apiSpec = `
  @service namespace PetStore;
  model Pet { id: int64 }
  @error model ApiError { code: string }
  @error model NotFound { @statusCode _: 404; message: string }
  @route("/pets") interface Pets {
    @get get(@path petId: int64): Pet | NotFound | ApiError;
    @post create(@body pet: Pet): { @statusCode _: 201; @header location: string; @body pet: Pet } | { @statusCode _: 200; @body pet: Pet };
  }
`;

describe("@abhigyakrishna/tspgen-typescript", () => {
  it("emits template models once as generic interfaces with schema functions", async () => {
    const { outputs } = await emitter({ features: { zod: true } }).compile(`
      @service namespace Shop;
      model Page<T> { items: T[]; total: int64 }
      model Pet { id: int64 }
      model Holder { pets: Page<Pet>; names: Page<string> }
    `);
    expect(outputs["models/Page.ts"]).toContain(`export interface Page<T> {
  items: T[];
  total: number;
}

export function PageSchema<T>(TSchema: z.ZodType<T>): z.ZodType<Page<T>> {
  return z.object({
    items: z.array(TSchema),
    total: z.number().int(),
  }) as unknown as z.ZodType<Page<T>>;
}`);
    const holder = outputs["models/Holder.ts"];
    expect(holder).toContain(`  pets: Page<Pet>;\n  names: Page<string>;`);
    expect(holder).toContain(`pets: z.lazy(() => PageSchema(z.lazy(() => PetSchema))),`);
    expect(holder).toContain(`names: z.lazy(() => PageSchema(z.string())),`);
    expect(Object.keys(outputs).some((p) => p.includes("PagePet"))).toBe(false);
  });

  it("maps generic templates with @TS.type to the mapped type with arguments", async () => {
    const { outputs } = await emitter().compile(`
      @service namespace Shop;
      @TS.type("Page", "../page") model Page<T> { items: T[] }
      model Pet { id: int64 }
      model Holder { pets: Page<Pet> }
    `);
    const holder = outputs["models/Holder.ts"];
    expect(holder).toContain(`import type { Page } from "../../page";`);
    expect(holder).toContain(`pets: Page<Pet>;`);
    expect(outputs["models/Page.ts"]).toBeUndefined();
  });

  it("emits interfaces", async () => {
    const { outputs } = await emitter().compile(spec);
    expect(outputs["models/Pet.ts"]).toBe(`${HEADER}
import type { Owner } from "./Owner";
import type { Species } from "./Species";

/**
 * A pet
 */
export interface Pet {
  id: number;
  name?: string;
  tags: string[];
  born_at: string;
  species: Species;
  /**
   * @default 1.5
   */
  weight?: number;
  owner: Owner | null;
  "x-meta"?: Record<string, unknown>;
}
`);
  });

  it("emits enums as literal unions plus const objects", async () => {
    const { outputs } = await emitter().compile(spec);
    expect(outputs["models/Species.ts"]).toBe(`${HEADER}

export type Species = "dog" | "cat" | "parrot";

export const Species = {
  Dog: "dog",
  Cat: "cat",
  Bird: "parrot",
} as const;
`);
  });

  it("emits discriminated hierarchies and a barrel", async () => {
    const { outputs } = await emitter().compile(spec);
    expect(outputs["models/Toy.ts"]).toBe(`${HEADER}
import type { Ball } from "./Ball";
import type { Rope } from "./Rope";

export type Toy = Ball | Rope;
`);
    expect(outputs["models/Ball.ts"]).toContain(`export interface Ball {
  kind: "ball";
  name: string;
  diameter: number;
}`);
    expect(outputs["models/index.ts"]).toBe(`${HEADER}

export * from "./Ball";
export * from "./Owner";
export * from "./Pet";
export * from "./Rope";
export * from "./Species";
export * from "./Toy";
`);
  });

  it("emits zod schemas when enabled", async () => {
    const { outputs } = await emitter({ features: { zod: true }, "import-extension": ".js" }).compile(spec);
    expect(outputs["models/Pet.ts"]).toContain(`${HEADER}
import { z } from "zod";
import { OwnerSchema } from "./Owner.js";
import type { Owner } from "./Owner.js";
import { SpeciesSchema } from "./Species.js";
import type { Species } from "./Species.js";
`);
    expect(outputs["models/Pet.ts"]).toContain(`
export const PetSchema: z.ZodType<Pet> = z.object({
  id: z.number().int(),
  name: z.string().exactOptional(),
  tags: z.array(z.string()),
  born_at: z.iso.datetime({ offset: true }),
  species: z.lazy(() => SpeciesSchema),
  weight: z.number().exactOptional(),
  owner: z.lazy(() => OwnerSchema).nullable(),
  "x-meta": z.record(z.string(), z.unknown()).exactOptional(),
});
`);
    expect(outputs["models/Species.ts"]).toContain(
      `export const SpeciesSchema: z.ZodType<Species> = z.enum(["dog", "cat", "parrot"]);`,
    );
    expect(outputs["models/Toy.ts"]).toContain(
      "export const ToySchema: z.ZodType<Toy> = z.union([z.lazy(() => BallSchema), z.lazy(() => RopeSchema)]);",
    );
  });

  it("emits error classes and result unions", async () => {
    const { outputs } = await emitter().compile(apiSpec);
    expect(outputs["api/errors.ts"]).toBe(`${HEADER}
import type { ApiError } from "../models/ApiError";
import type { NotFound } from "../models/NotFound";

/** Base class for non-success HTTP responses; \`body\` is the raw decoded response body. */
export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message?: string) {
    super(message ?? \`HTTP \${status}\`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

export class NotFoundError extends HttpError {
  readonly error: NotFound;

  constructor(status: number, error: NotFound) {
    super(status, error);
    this.name = "NotFoundError";
    this.error = error;
  }
}

export class ApiErrorError extends HttpError {
  readonly error: ApiError;

  constructor(status: number, error: ApiError) {
    super(status, error);
    this.name = "ApiErrorError";
    this.error = error;
  }
}
`);
    expect(outputs["api/results.ts"]).toBe(`${HEADER}
import type { Pet } from "../models/Pet";

export type CreateResult =
  | { status: 201; body: Pet; headers: { location: string } }
  | { status: 200; body: Pet };
`);
    expect(outputs["api/index.ts"]).toBe(`${HEADER}

export * from "./errors";
export * from "./results";
`);
  });

  it("emits no api files without operations", async () => {
    const { outputs } = await emitter().compile(`model Lonely { x: int32 }`);
    expect(Object.keys(outputs).some((k) => k.startsWith("api/"))).toBe(false);
  });

  it("adds constraint decorators and notBlank to zod schemas", async () => {
    const { outputs } = await emitter({ features: { zod: true }, layout: "single-file" }).compile(`
      using TspGen;
      @service namespace S;
      @maxLength(8) scalar Code extends string;
      model Req {
        @minLength(1) @maxLength(64) name: string;
        @pattern("^[a-z]+$") slug?: string;
        code: Code;
        @minValue(0) @maxValue(10) score: int32;
        @minItems(1) tags: string[];
        note: string | null;
        @TS.type("Date") at: string;
        plain: string;
      }
      @@meta(Req.name, "*", #{ notBlank: true });
      @@meta(Req.note, "typescript", #{ notBlank: true });
      @@meta(Req.plain, "kotlin", #{ notBlank: true });
      @route("/r") op create(@body req: Req, @query @maxValue(50) limit?: int32): void;
    `);
    const types = outputs["types.ts"];
    expect(types).toContain(`  name: z.string().regex(/\\S/, "must not be blank").min(1).max(64),\n`);
    expect(types).toContain(`  slug: z.string().regex(new RegExp("^[a-z]+$", "u")).exactOptional(),\n`);
    expect(types).toContain(`  code: z.string().max(8),\n`);
    expect(types).toContain(`  score: z.number().int().gte(0).lte(10),\n`);
    expect(types).toContain(`  tags: z.array(z.string()).min(1),\n`);
    expect(types).toContain(`  note: z.string().regex(/\\S/, "must not be blank").nullable(),\n`);
    expect(types).toContain(`  at: z.custom<Date>(),\n`);
    expect(types).toContain(`  plain: z.string(),\n`);
  });

  it("skips a @pattern JavaScript cannot parse and warns", async () => {
    const [{ outputs }, diagnostics] = await emitter({ features: { zod: true }, layout: "single-file" }).compileAndDiagnose(`
      @service namespace S;
      model Req { @pattern("(?i)abc") a: string; @pattern("^\\\\p{L}+$") b: string }
      @route("/r") op create(@body req: Req, @query @pattern("(?i)x") q: string): void;
    `);
    expect(outputs["types.ts"]).toContain(`  a: z.string(),\n`);
    expect(outputs["types.ts"]).toContain(`  b: z.string().regex(new RegExp("^\\\\p{L}+$", "u")),\n`);
    // TypeSpec's own invalid-pattern-regex warning fires too; only ours is checked here.
    expectDiagnostics(diagnostics.filter((d) => d.code.startsWith("@abhigyakrishna/")), [
      {
        code: "@abhigyakrishna/tspgen-typescript/invalid-pattern",
        severity: "warning",
        message: "@pattern '(?i)abc' on 'S.Req.a' is not a valid JavaScript regular expression; it is not validated.",
      },
      {
        code: "@abhigyakrishna/tspgen-typescript/invalid-pattern",
        message: "@pattern '(?i)x' on 'S.create.q' is not a valid JavaScript regular expression; it is not validated.",
      },
    ]);
  });

  it("does not warn about unparsable patterns without zod (patterns are not emitted)", async () => {
    const [, diagnostics] = await emitter({ layout: "single-file" }).compileAndDiagnose(`
      @service namespace S;
      model Req { @pattern("(?i)abc") a: string }
      @route("/r") op create(@body req: Req, @query @pattern("(?i)x") q: string): void;
    `);
    expect(diagnostics.filter((d) => d.code.startsWith("@abhigyakrishna/"))).toEqual([]);
  });
});

describe("modelsPrefix", () => {
  it("rebases models-rooted imports for targets writing elsewhere", () => {
    const prefix = modelsPrefix("/p/web/src", "/p/shared");
    expect(prefix).toBe("../../shared");
    expect(renderImports("client/a", [{ name: "Pet", from: "models/Pet", typeOnly: true, root: "models" }], "", prefix)).toEqual([
      `import type { Pet } from "../../../shared/models/Pet";`,
    ]);
    expect(modelsPrefix("/p/out", "/p/out")).toBe("");
  });
});

