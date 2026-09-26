import { describe, expect, it } from "vitest";
import { nextjs, petSpec } from "./tester.js";
import { typecheck } from "./typecheck.js";

const withMeta = `using TspGen;\n${petSpec}
  @@meta(PetStore.Pets, "typescript:ts-nextjs-client", #{ next: #{ revalidate: 60, tags: #["pets"] }, staleTime: 30000 });
  @@meta(PetStore.Pets.get, "typescript:ts-nextjs-client", #{ next: #{ revalidate: 5, tags: #["pet"] } });
`;

describe("ts-nextjs @meta keys", () => {
  it("applies default next fetch options (operation overrides group)", async () => {
    const { outputs } = await nextjs().compile(withMeta);
    const pets = outputs["client/pets.ts"];
    expect(pets).toContain(`      { next: {"revalidate":60,"tags":["pets"]}, ...options },`);
    expect(pets).toContain(`      { next: {"revalidate":5,"tags":["pet"]}, ...options },`);
    expect(outputs["client/petStore.ts"]).toContain("      options,\n");
  });

  it("applies default staleTime to queryOptions and still type-checks", async () => {
    const { outputs } = await nextjs().compile(withMeta);
    expect(outputs["client/react-query/queries.ts"]).toContain(`        queryFn: ({ signal }) => client.pets.get(params, { signal }),
        staleTime: 30000,
      }),`);
    expect(typecheck({ ...outputs, "env.d.ts": "declare const process: { env: Record<string, string | undefined> };\n" })).toBe("");
  });
});
