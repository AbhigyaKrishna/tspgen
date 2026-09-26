import { describe, expect, it } from "vitest";
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

describe("@tspgen/emitter-typescript", () => {
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
    const { outputs } = await emitter({ zod: true, "import-extension": ".js" }).compile(spec);
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
  name: z.string().optional(),
  tags: z.array(z.string()),
  born_at: z.iso.datetime({ offset: true }),
  species: z.lazy(() => SpeciesSchema),
  weight: z.number().optional(),
  owner: z.lazy(() => OwnerSchema).nullable(),
  "x-meta": z.record(z.string(), z.unknown()).optional(),
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
});
