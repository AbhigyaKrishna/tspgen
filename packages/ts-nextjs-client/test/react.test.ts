import { expectDiagnostics } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { nextjs, petSpec } from "./tester.js";
import { typecheck } from "./typecheck.js";

describe("next.js react-query and server actions", () => {
  it("emits query keys and queryOptions without a client directive", async () => {
    const { outputs } = await nextjs().compile(petSpec);
    const queries = outputs["client/react-query/queries.ts"];
    expect(queries).not.toContain(`"use client"`);
    expect(queries).toContain(`export const petStoreKeys = {
  all: ["PetStore"] as const,
  petStore: {
    all: ["PetStore", "petStore"] as const,
    health: () => ["PetStore", "petStore", "health"] as const,
  },
  pets: {
    all: ["PetStore", "pets"] as const,
    list: (params: PetsListParams = {}) => ["PetStore", "pets", "list", params] as const,
    get: (params: PetsGetParams) => ["PetStore", "pets", "get", params] as const,
  },
};`);
    expect(queries).toContain(`    get: (client: PetStoreApiClient, params: PetsGetParams) =>
      queryOptions({
        queryKey: petStoreKeys.pets.get(params),
        queryFn: ({ signal }) => client.pets.get(params, { signal }),
      }),`);
  });

  it("resolves void GET/HEAD queries to null", async () => {
    const spec = `@service namespace S;
      @route("/n") interface Ns {
        @head @route("/{id}") exists(@path id: string): void;
      }`;
    const { outputs } = await nextjs({ features: { "server-actions": false } }).compile(spec);
    expect(outputs["client/react-query/queries.ts"]).toContain(`    exists: (client: SApiClient, params: NsExistsParams) =>
      queryOptions({
        queryKey: sKeys.ns.exists(params),
        queryFn: async ({ signal }) => {
          await client.ns.exists(params, { signal });
          return null;
        },
      }),`);
    expect(outputs["client/react-query/hooks.ts"]).toContain(
      `  options?: Omit<UseQueryOptions<null, Error, null, ReturnType<typeof sKeys.ns.exists>>, "queryKey" | "queryFn">,`,
    );
    expect(typecheck(outputs)).toBe("");
  });

  it("emits hooks in a use-client module", async () => {
    const { outputs } = await nextjs().compile(petSpec);
    const hooks = outputs["client/react-query/hooks.ts"];
    expect(hooks.split("\n")[1]).toBe(`"use client";`);
    expect(hooks).toContain("export function PetStoreClientProvider(");
    expect(hooks).toContain(`export function usePetsGetQuery(
  params: PetsGetParams,
  options?: Omit<UseQueryOptions<Pet, Error, Pet, ReturnType<typeof petStoreKeys.pets.get>>, "queryKey" | "queryFn">,
) {`);
    expect(hooks).toContain(`export function usePetsCreateMutation(
  options?: Omit<UseMutationOptions<CreateResult, Error, PetsCreateParams>, "mutationFn">,
) {
  const client = usePetStoreClient();
  return useMutation({ ...options, mutationFn: (params: PetsCreateParams) => client.pets.create(params) });
}`);
    expect(hooks).not.toContain("usePetsCreateQuery");
  });

  it("emits server actions for mutations only", async () => {
    const { outputs } = await nextjs({}, { features: { zod: true } }).compile(petSpec);
    const actions = outputs["client/actions/pets.ts"];
    expect(actions.split("\n")[1]).toBe(`"use server";`);
    expect(actions).toContain(`export async function petsCreateAction(params: PetsCreateParams): Promise<ActionResult<CreateResult>> {
  const parsed = PetsCreateParamsSchema.safeParse(withoutUndefined(params));
  if (!parsed.success) return { ok: false, status: 400, error: { issues: parsed.error.issues } };
  return runAction(() => petStoreServerClient().pets.create(parsed.data));
}`);
    expect(actions).toContain(`import { withoutUndefined } from "../core";`);
    expect(outputs["client/core.ts"]).toContain("export function withoutUndefined(value: unknown): unknown {");
    expect(actions).not.toContain("petsGetAction");
    expect(outputs["client/actions/petStore.ts"]).toBeUndefined();
    expect(outputs["client/actions/server-client.ts"]).toContain("const baseUrl = overrides.baseUrl ?? process.env.API_BASE_URL;");
  });

  it("respects feature toggles and base-url-env", async () => {
    const { outputs } = await nextjs({ features: { "react-query": false }, "base-url-env": "PETS_URL" }).compile(petSpec);
    expect(Object.keys(outputs).some((k) => k.includes("react-query"))).toBe(false);
    expect(outputs["client/actions/server-client.ts"]).toContain("process.env.PETS_URL");
  });

  it("skips hooks and actions for non-JSON bodies with a warning", async () => {
    const [{ outputs }, diagnostics] = await nextjs().compileAndDiagnose(`
      @service namespace S;
      @route("/notes") @post op addNote(@header contentType: "text/plain", @body note: string): void;
    `);
    expectDiagnostics(diagnostics, { code: "@abhigyakrishna/tspgen-typescript/non-json-body", severity: "warning" });
    expect(outputs["client/s.ts"]).toContain("async addNote(");
    expect(outputs["client/actions/s.ts"]).toBeUndefined();
  });

  it("type-checks with react-query and server actions, with and without zod", async () => {
    for (const zod of [false, true]) {
      const { outputs } = await nextjs({}, { features: { zod } }).compile(petSpec);
      expect(typecheck({ ...outputs, "env.d.ts": "declare const process: { env: Record<string, string | undefined> };\n" })).toBe("");
    }
  });
});
