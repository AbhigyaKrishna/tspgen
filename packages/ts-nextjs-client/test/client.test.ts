import { describe, expect, it } from "vitest";
import { nextjs, petSpec } from "./tester.js";
import { typecheck } from "./typecheck.js";

const fetchOnly = { "react-query": false, "server-actions": false };

describe("next.js fetch client", () => {
  it("emits params interfaces and a client class per group", async () => {
    const { outputs } = await nextjs(fetchOnly).compile(petSpec);
    const pets = outputs["client/pets.ts"];
    expect(pets).toContain(`export interface PetsGetParams {
  petId: number;
  trace?: string;
  session?: string;
}`);
    expect(pets).toContain(`export class PetsClient {
  private readonly config: ClientConfig;

  constructor(config: ClientConfig) {
    this.config = config;
  }`);
    expect(pets).toContain(`  /**
   * List pets
   */
  async list(params: PetsListParams = {}, options?: RequestOptions): Promise<Pet[]> {`);
  });

  it("builds requests with path, query, header, cookie and body", async () => {
    const { outputs } = await nextjs(fetchOnly).compile(petSpec);
    const pets = outputs["client/pets.ts"];
    expect(pets).toContain(`        path: "/pets",
        query: [["limit", params.limit, false], ["tags", params.tags, true], ["ids", params.ids, false]],`);
    expect(pets).toContain(`        path: \`/pets/\${encodeURIComponent(String(params.petId))}\`,
        headers: { "x-trace": params.trace },
        cookies: { session: params.session },`);
    expect(pets).toContain(`        body: params.pet,
        contentType: "application/json",`);
  });

  it("maps success and error responses", async () => {
    const { outputs } = await nextjs(fetchOnly).compile(petSpec);
    const pets = outputs["client/pets.ts"];
    expect(pets).toContain(`    if (res.ok) return parse<Pet>(this.config, res);
    throw await toError(res, {
      404: (status, body) => new NotFoundError(status, body as NotFound),
      default: (status, body) => new ApiErrorError(status, body as ApiError),
    });`);
    expect(pets).toContain(
      `    if (res.status === 201) return { status: 201, body: await parse<Pet>(this.config, res), headers: { location: requireHeader(res, "location"), count: optionalHeader(res, "x-count", Number) } };`,
    );
    expect(pets).toContain(`    if (res.ok) return;`);
    expect(pets).toContain(`    throw await toError(res, {});`);
  });

  it("validates with zod schemas when enabled", async () => {
    const { outputs } = await nextjs(fetchOnly, { zod: true }).compile(petSpec);
    const pets = outputs["client/pets.ts"];
    expect(pets).toContain(`export const PetsGetParamsSchema: z.ZodType<PetsGetParams> = z.object({
  petId: z.number().int(),
  trace: z.string().optional(),
  session: z.string().optional(),
});`);
    expect(pets).toContain(`if (res.ok) return parse(this.config, res, z.lazy(() => PetSchema));`);
  });

  it("emits the aggregate client and runtime core", async () => {
    const { outputs } = await nextjs(fetchOnly).compile(petSpec);
    expect(outputs["client/index.ts"]).toContain(`export class PetStoreApiClient {
  readonly petStore: PetStoreClient;
  readonly pets: PetsClient;

  constructor(config: ClientConfig) {
    this.petStore = new PetStoreClient(config);
    this.pets = new PetsClient(config);
  }
}

export function createPetStoreClient(config: ClientConfig): PetStoreApiClient {
  return new PetStoreApiClient(config);
}`);
    expect(outputs["client/index.ts"]).toContain(`export * from "./core";\nexport * from "./petStore";\nexport * from "./pets";`);
    expect(outputs["client/core.ts"]).toContain("export async function request(");
    expect(outputs["client/petStore.ts"]).toContain("async health(options?: RequestOptions): Promise<HealthResponse> {");
  });

  it("imports the models from their own output dir when the client writes elsewhere", async () => {
    const { outputs } = await nextjs(
      { ...fetchOnly, "output-dir": "{emitter-output-dir}/web/src" },
      { zod: true, "models-output-dir": "{emitter-output-dir}/shared" },
    ).compile(petSpec);
    expect(outputs["web/src/client/pets.ts"]).toContain(`import type { Pet } from "../../../shared/models/Pet";`);
    expect(outputs["web/src/client/core.ts"]).toContain(`import { HttpError } from "../../../shared/api/errors";`);
    expect(outputs["shared/models/Pet.ts"]).toContain("export interface Pet {");
    expect(typecheck(outputs)).toBe("");
  });

  it("type-checks generic responses, with and without zod, in both client styles", async () => {
    const spec = `
      @service namespace Shop;
      model Page<T> { items: T[]; total: int64 }
      model Pet { id: int64; name: string }
      @route("/pets") interface Pets {
        @get listPets(@query offset?: int32): Page<Pet>;
        @post createPet(@body pet: Pet): Pet;
      }
    `;
    for (const zod of [false, true]) {
      for (const style of [fetchOnly, { "client-style": "flat" }] as Record<string, unknown>[]) {
        const { outputs } = await nextjs(style, { zod }).compile(spec);
        const client = outputs["client/pets.ts"] ?? outputs["client.ts"];
        expect(client).toContain("Page<Pet>");
        expect(typecheck(outputs)).toBe("");
      }
    }
  });

  it("type-checks without and with zod", async () => {
    for (const zod of [false, true]) {
      const { outputs } = await nextjs(fetchOnly, { zod }).compile(petSpec);
      expect(typecheck(outputs)).toBe("");
    }
  });
});
