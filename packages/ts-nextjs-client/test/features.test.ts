import type { Diagnostic } from "@typespec/compiler";
import { expectDiagnostics } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { nextjs, petSpec } from "./tester.js";
import { typecheck } from "./typecheck.js";

const ENV = { "env.d.ts": "declare const process: { env: Record<string, string | undefined> };\n" };
const HOUSE = { layout: "single-file", errors: "thrown" };

/** A spec both client styles accept (no header/cookie params, one success response each). */
const flatSpec = `
  using TspGen;
  @service namespace Shop;
  model Node { id: string }
  @route("/nodes") interface Nodes {
    @get list(@query limit?: int32): Node[];
    @get @route("/{id}") read(@path id: string): Node;
    @post create(@body node: Node): Node;
  }
`;

const featureWarnings = (diagnostics: readonly Diagnostic[]) =>
  diagnostics.filter((d) => d.code === "@abhigyakrishna/tspgen-core/unsupported-feature");
const unsupported = (message: string) => ({ code: "@abhigyakrishna/tspgen-core/unsupported-feature", severity: "warning" as const, message });

describe("features.server-only", () => {
  it('imports server-only first in server-client.ts, not in the "use server" files', async () => {
    const { outputs } = await nextjs().compile(petSpec);
    const lines = outputs["client/actions/server-client.ts"]!.split("\n");
    expect(lines[1]).toBe(`import "server-only";`);
    expect(lines[2]).toMatch(/^import /);
    expect(outputs["client/actions/pets.ts"]).not.toContain("server-only");
    expect(outputs["client/actions/result.ts"]).not.toContain("server-only");
    expect(typecheck({ ...outputs, ...ENV })).toBe("");
  });

  it("is left out when off", async () => {
    const { outputs } = await nextjs({ features: { "server-only": false } }).compile(petSpec);
    expect(outputs["client/actions/server-client.ts"]).toBeDefined();
    for (const content of Object.values(outputs)) expect(content).not.toContain("server-only");
  });

  it("warns when set explicitly without a server-client.ts to put it in", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ "client-style": "flat", features: { "server-only": true } }, '`features.server-only` has no effect with client-style "flat".'],
      [{ features: { "server-only": true, "server-actions": false } }, "`features.server-only` has no effect with `features.server-actions` off."],
    ];
    for (const [options, message] of cases) {
      const [{ outputs }, diagnostics] = await nextjs(options, HOUSE).compileAndDiagnose(flatSpec);
      expectDiagnostics(featureWarnings(diagnostics), unsupported(message));
      for (const content of Object.values(outputs)) expect(content).not.toContain("server-only");
    }
  });

  it("does not warn on the default", async () => {
    for (const options of [{ "client-style": "flat" }, { features: { "server-actions": false } }]) {
      const [, diagnostics] = await nextjs(options, HOUSE).compileAndDiagnose(flatSpec);
      expect(featureWarnings(diagnostics)).toEqual([]);
    }
  });
});

describe("features.hooks", () => {
  it("drops the grouped hooks.ts and keeps queries.ts unchanged", async () => {
    const on = await nextjs().compile(petSpec);
    const { outputs } = await nextjs({ features: { hooks: false } }).compile(petSpec);
    expect(on.outputs["client/react-query/hooks.ts"]).toBeDefined();
    expect(outputs["client/react-query/hooks.ts"]).toBeUndefined();
    expect(outputs["client/react-query/queries.ts"]).toBe(on.outputs["client/react-query/queries.ts"]);
    for (const content of Object.values(outputs)) expect(content).not.toContain(`from "react"`);
    expect(typecheck({ ...outputs, ...ENV })).toBe("");
  });

  it("drops the flat hooks.ts and keeps queries.ts and index.ts unchanged", async () => {
    const on = await nextjs({ "client-style": "flat" }, HOUSE).compile(flatSpec);
    const { outputs } = await nextjs({ "client-style": "flat", features: { hooks: false } }, HOUSE).compile(flatSpec);
    expect(on.outputs["hooks.ts"]).toBeDefined();
    expect(outputs["hooks.ts"]).toBeUndefined();
    expect(outputs["queries.ts"]).toBe(on.outputs["queries.ts"]);
    expect(outputs["index.ts"]).toBe(on.outputs["index.ts"]);
    for (const content of Object.values(outputs)) expect(content).not.toContain(`from "react"`);
    expect(typecheck(outputs)).toBe("");
  });

  it("frees the flat hook, provider and context names for generated types when off", async () => {
    for (const name of ["useReadQuery", "useCreateMutation", "ShopClientProvider", "useShopClient", "ShopClientContext", "ReactNode", "useQuery"]) {
      const spec = `${flatSpec}\n@TS.name("${name}") model Clash { x: string }`;
      const [, on] = await nextjs({ "client-style": "flat" }, HOUSE).compileAndDiagnose(spec);
      expectDiagnostics(on, { code: "@abhigyakrishna/tspgen-typescript/flat-client-name-clash" });
      const [{ outputs }, off] = await nextjs({ "client-style": "flat", features: { hooks: false } }, HOUSE).compileAndDiagnose(spec);
      expect(off).toEqual([]);
      expect(outputs["queries.ts"]).toBeDefined();
    }
    // queries.ts names still clash without hooks
    for (const name of ["ReadVars", "shopKeys", "shopQueries", "queryOptions"]) {
      const spec = `${flatSpec}\n@TS.name("${name}") model Clash { x: string }`;
      const [, off] = await nextjs({ "client-style": "flat", features: { hooks: false } }, HOUSE).compileAndDiagnose(spec);
      expectDiagnostics(off, { code: "@abhigyakrishna/tspgen-typescript/flat-client-name-clash" });
    }
  });

  it("warns when set explicitly without react-query", async () => {
    for (const style of [{}, { "client-style": "flat" }]) {
      const [{ outputs }, diagnostics] = await nextjs({ ...style, features: { "react-query": false, hooks: true } }, HOUSE).compileAndDiagnose(flatSpec);
      expectDiagnostics(featureWarnings(diagnostics), unsupported("`features.hooks` has no effect with `features.react-query` off."));
      expect(Object.keys(outputs).some((k) => k.includes("hooks"))).toBe(false);
      const [, quiet] = await nextjs({ ...style, features: { "react-query": false } }, HOUSE).compileAndDiagnose(flatSpec);
      expect(featureWarnings(quiet)).toEqual([]);
    }
  });
});

describe("features.error-getters", () => {
  it("keeps the status getters on the flat error class by default and drops them when off", async () => {
    const on = (await nextjs({ "client-style": "flat" }, HOUSE).compile(flatSpec)).outputs["client.ts"]!;
    expect(on).toContain("  get isNotFound(): boolean {\n    return this.status === 404;\n  }");
    const { outputs } = await nextjs({ "client-style": "flat", features: { "error-getters": false } }, HOUSE).compile(flatSpec);
    const client = outputs["client.ts"]!;
    for (const getter of ["isUnauthorized", "isForbidden", "isNotFound", "isConflict"]) expect(client).not.toContain(getter);
    expect(client).toContain("    this.problem = problem;\n  }\n}\n");
    expect(typecheck(outputs)).toBe("");
  });

  it("warns when set explicitly for the grouped client", async () => {
    const [, diagnostics] = await nextjs({ features: { "error-getters": true } }).compileAndDiagnose(petSpec);
    expectDiagnostics(
      featureWarnings(diagnostics),
      unsupported('`features.error-getters` has no effect with client-style "grouped"; use the typed error classes.'),
    );
    const [, quiet] = await nextjs().compileAndDiagnose(petSpec);
    expect(featureWarnings(quiet)).toEqual([]);
  });
});

describe("query-key-prefix", () => {
  it("prepends the prefix to every grouped key", async () => {
    const { outputs } = await nextjs({ "query-key-prefix": "api" }).compile(petSpec);
    expect(outputs["client/react-query/queries.ts"]).toContain(`export const petStoreKeys = {
  all: ["api", "PetStore"] as const,
  petStore: {
    all: ["api", "PetStore", "petStore"] as const,
    health: () => ["api", "PetStore", "petStore", "health"] as const,
  },
  pets: {
    all: ["api", "PetStore", "pets"] as const,
    list: (params: PetsListParams = {}) => ["api", "PetStore", "pets", "list", params] as const,
    get: (params: PetsGetParams) => ["api", "PetStore", "pets", "get", params] as const,
  },
};`);
    expect(outputs["client/react-query/hooks.ts"]).toContain("ReturnType<typeof petStoreKeys.pets.get>");
    expect(typecheck({ ...outputs, ...ENV })).toBe("");
  });

  it("prepends the prefix to every flat key", async () => {
    const { outputs } = await nextjs({ "client-style": "flat", "query-key-prefix": "api" }, HOUSE).compile(flatSpec);
    const queries = outputs["queries.ts"]!;
    expect(queries).toContain(`  all: ["api", "Shop"] as const,\n`);
    expect(queries).toContain(`    all: ["api", "Shop", "nodes"] as const,\n`);
    expect(queries).toContain(`    read: (vars: ReadVars) => ["api", "Shop", "nodes", "read", vars] as const,\n`);
    expect(outputs["hooks.ts"]).toContain("ReturnType<typeof shopKeys.nodes.read>");
    expect(typecheck(outputs)).toBe("");
  });

  it("is ignored silently without react-query", async () => {
    for (const style of [{}, { "client-style": "flat" }]) {
      const [{ outputs }, diagnostics] = await nextjs({ ...style, "query-key-prefix": "api", features: { "react-query": false } }, HOUSE).compileAndDiagnose(flatSpec);
      expect(diagnostics.filter((d) => d.code.startsWith("@abhigyakrishna/"))).toEqual([]);
      for (const content of Object.values(outputs)) expect(content).not.toContain(`"api"`);
    }
  });

  it("treats an empty grouped prefix as unset", async () => {
    const { outputs } = await nextjs({ "query-key-prefix": "" }).compile(petSpec);
    expect(outputs["client/react-query/queries.ts"]).toContain(`export const petStoreKeys = {
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
    expect(typecheck({ ...outputs, ...ENV })).toBe("");
  });

  it("treats an empty flat prefix as unset", async () => {
    const { outputs } = await nextjs({ "client-style": "flat", "query-key-prefix": "" }, HOUSE).compile(flatSpec);
    const queries = outputs["queries.ts"]!;
    expect(queries).toContain(`  all: ["Shop"] as const,\n`);
    expect(queries).toContain(`    all: ["Shop", "nodes"] as const,\n`);
    expect(queries).toContain(`    read: (vars: ReadVars) => ["Shop", "nodes", "read", vars] as const,\n`);
    expect(typecheck(outputs)).toBe("");
  });
});
