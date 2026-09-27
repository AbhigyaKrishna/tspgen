import { expectDiagnostics } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { nextjs, petSpec } from "./tester.js";
import { typecheck } from "./typecheck.js";

const fetchOnly = { features: { "react-query": false, "server-actions": false } };

describe("next.js fetch client", () => {
  it.each([
    ["react-query", "features.react-query"],
    ["server-actions", "features.server-actions"],
    ["validate", "features.validate"],
  ])("rejects the moved option %s", async (key, to) => {
    const diagnostics = await nextjs({ [key]: true }).diagnose(petSpec);
    expectDiagnostics(diagnostics, {
      code: "@abhigyakrishna/tspgen-core/option-moved",
      message: `\`${key}\` moved to \`${to}\` in 0.2.0.`,
    });
  });

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
      `    if (res.status === 201) return { status: 201, body: await parse<Pet>(this.config, res), headers: { location: requireHeader(res, "location"), ...optionalEntry("count", optionalHeader(res, "x-count", Number)) } };`,
    );
    expect(pets).toContain(`    if (res.ok) return;`);
    expect(pets).toContain(`    throw await toError(res, {});`);
  });

  it("validates with zod schemas when enabled", async () => {
    const { outputs } = await nextjs(fetchOnly, { features: { zod: true } }).compile(petSpec);
    const pets = outputs["client/pets.ts"];
    expect(pets).toContain(`export const PetsGetParamsSchema: z.ZodType<PetsGetParams> = z.object({
  petId: z.number().int(),
  trace: z.string().exactOptional(),
  session: z.string().exactOptional(),
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

  it("keeps upload machinery out of core.ts when no operation uploads", async () => {
    const { outputs } = await nextjs(fetchOnly).compile(petSpec);
    const core = outputs["client/core.ts"];
    for (const upload of ["PartSpec", "toFormData", "multipart", "file?: boolean", "BodyInit"]) expect(core).not.toContain(upload);
    expect(core).toContain(`  let body: string | undefined;
  if (spec.body !== undefined) {
    const contentType = spec.contentType ?? "application/json";`);
    expect(typecheck(outputs)).toBe("");
  });

  it("imports the models from their own output dir when the client writes elsewhere", async () => {
    const { outputs } = await nextjs(
      { ...fetchOnly, "output-dir": "{emitter-output-dir}/web/src" },
      { features: { zod: true }, "models-output-dir": "{emitter-output-dir}/shared" },
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
        const { outputs } = await nextjs(style, { features: { zod } }).compile(spec);
        const client = outputs["client/pets.ts"] ?? outputs["client.ts"];
        expect(client).toContain("Page<Pet>");
        expect(typecheck(outputs)).toBe("");
      }
    }
  });

  it("type-checks without and with zod", async () => {
    for (const zod of [false, true]) {
      const { outputs } = await nextjs(fetchOnly, { features: { zod } }).compile(petSpec);
      expect(typecheck(outputs)).toBe("");
    }
  });

  it("applies parameter constraints to the params schema", async () => {
    const { outputs } = await nextjs({}, { features: { zod: true } }).compile(`
      @service namespace S;
      @route("/items") interface Items { @get list(@query @maxValue(100) limit?: int32): void; }
    `);
    expect(outputs["client/items.ts"]).toContain("z.number().int().lte(100)");
  });

  it("type-checks grouped client params schemas of optional query params under exactOptionalPropertyTypes", async () => {
    const { outputs } = await nextjs(fetchOnly, { features: { zod: true } }).compile(`
      @service namespace S;
      @route("/items") interface Items { @get list(@query limit?: int32): void; }
    `);
    expect(typecheck(outputs, { exactOptionalPropertyTypes: true })).toBe("");
  });

  it("warns that features.validate has no effect with the grouped style, only when set explicitly", async () => {
    const [{ outputs }, diagnostics] = await nextjs({ features: { ...fetchOnly.features, validate: true } }, { features: { zod: true } }).compileAndDiagnose(
      petSpec,
    );
    expectDiagnostics(
      diagnostics.filter((d) => d.code.startsWith("@abhigyakrishna/")),
      {
        code: "@abhigyakrishna/tspgen-core/unsupported-feature",
        severity: "warning",
        message: '`features.validate` has no effect with client-style "grouped".',
      },
    );
    expect(outputs["client/pets.ts"]).toBeDefined();
    const [, byDefault] = await nextjs(fetchOnly, { features: { zod: true } }).compileAndDiagnose(petSpec);
    expect(byDefault.filter((d) => d.code.endsWith("unsupported-feature"))).toEqual([]);
  });

  it("type-checks the full grouped client under exactOptionalPropertyTypes and noUncheckedIndexedAccess", async () => {
    const env = { "env.d.ts": "declare const process: { env: Record<string, string | undefined> };\n" };
    for (const zod of [false, true]) {
      const { outputs } = await nextjs({}, { features: { zod } }).compile(petSpec);
      expect(typecheck({ ...outputs, ...env }, { exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true })).toBe("");
    }
  });
});
