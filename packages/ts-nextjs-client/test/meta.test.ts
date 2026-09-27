import { describe, expect, it } from "vitest";
import { nextjs, petSpec, sseNextjs } from "./tester.js";
import { typecheck } from "./typecheck.js";

const withMeta = `using TspGen;\n${petSpec}
  @@meta(PetStore.Pets, "typescript:ts-nextjs-client", #{ next: #{ revalidate: 60, tags: #["pets"] }, staleTime: 30000 });
  @@meta(PetStore.Pets.get, "typescript:ts-nextjs-client", #{ next: #{ revalidate: 5, tags: #["pet"] } });
`;

describe("ts-nextjs @meta keys", () => {
  it("inherits next fetch options from an enclosing namespace onto operations", async () => {
    const spec = `using TspGen;\n${petSpec}
      @@meta(PetStore, "typescript:ts-nextjs-client", #{ next: #{ revalidate: 120, tags: #["all"] } });
    `;
    const { outputs } = await nextjs().compile(spec);
    expect(outputs["client/pets.ts"]).toContain(`      { next: {"revalidate":120,"tags":["all"]}, ...options },`);
  });

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

describe("ts-nextjs @meta keys (flat client)", () => {
  const flatMeta = `using TspGen;
    @service namespace Shop;
    model Item { id: string }
    @events union Ticks { tick: int32 }
    @route("/items") interface Items {
      @get list(): Item[];
      @get @route("/{id}") read(@path id: string): Item;
      @get @route("/watch") watch(): SSEStream<Ticks>;
    }
    @@meta(Shop.Items.read, "typescript:ts-nextjs-client", #{ next: #{ revalidate: 5, tags: #["item"] } });
    @@meta(Shop.Items.watch, "typescript:ts-nextjs-client", #{ next: #{ revalidate: 0 } });
  `;

  it("sends @meta next defaults under the caller's options, once per invalid meta warning", async () => {
    const [{ outputs }, diagnostics] = await sseNextjs({ "client-style": "flat" }, { layout: "single-file" }).compileAndDiagnose(flatMeta);
    expect(diagnostics.filter((d) => d.code.startsWith("@abhigyakrishna/"))).toEqual([]);
    const client = outputs["client.ts"]!;
    expect(client).toContain(
      '    return this.send("GET", `/items/${encodeURIComponent(String(id))}`, undefined, { next: {"revalidate":5,"tags":["item"]}, ...init });',
    );
    expect(client).toContain('    return this.send("GET", "/items", undefined, init);');
    expect(client).toContain(
      '    const response = await this.request("GET", "/items/watch", undefined, { next: {"revalidate":0}, ...init, accept: "text/event-stream" });',
    );
    expect(typecheck(outputs)).toBe("");
  });

  it("reports an invalid next meta once", async () => {
    const [, diagnostics] = await nextjs({ "client-style": "flat" }).compileAndDiagnose(`using TspGen;
      @service namespace Shop;
      @route("/items") interface Items { @get list(): string[]; }
      @@meta(Shop.Items.list, "typescript:ts-nextjs-client", #{ next: 5 });
    `);
    expect(diagnostics.filter((d) => d.code === "@abhigyakrishna/tspgen-core/invalid-meta")).toHaveLength(1);
  });
});
