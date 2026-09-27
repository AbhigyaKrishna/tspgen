import { resolvePath } from "@typespec/compiler";
import { createTester, expectDiagnostics } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { emitter, HEADER } from "./tester.js";

const VersionedTester = createTester(resolvePath(import.meta.dirname, ".."), {
  libraries: ["@typespec/http", "@typespec/versioning", "@abhigyakrishna/tspgen-core", "@abhigyakrishna/tspgen-typescript"],
})
  .importLibraries()
  .using("Http", "Versioning");

function versioned(options: Record<string, unknown> = {}) {
  return VersionedTester.emit("@abhigyakrishna/tspgen-typescript", options);
}


const spec = `
  @service @versioned(Versions) namespace PetStore;
  enum Versions { v1: "2024-01-01", v2: "2024-06-01" }
  model Pet {
    id: int64;
    @renamedFrom(Versions.v2, "title") name: string;
    @added(Versions.v2) age?: int32;
    @madeOptional(Versions.v2) tag?: string;
  }
  @added(Versions.v2) model Toy { name: string }
`;

describe("versioning", () => {
  it("exports API_VERSION from the models barrel", async () => {
    const { outputs } = await versioned().compile(spec);
    expect(outputs["models/index.ts"]).toBe(`${HEADER}

export * from "./Pet";
export * from "./Toy";

/** Version of the PetStore API this code was generated for. */
export const API_VERSION = "2024-06-01";
`);
    expect(outputs["models/Pet.ts"]).toContain(`export interface Pet {
  id: number;
  name: string;
  age?: number;
  tag?: string;
}`);
  });

  it("emits no API_VERSION with features.api-version false", async () => {
    const { outputs } = await versioned({ features: { "api-version": false } }).compile(spec);
    expect(outputs["models/index.ts"]).not.toContain("API_VERSION");
  });

  it("moves API_VERSION to models/api-version.ts with features.barrel false", async () => {
    const { outputs } = await versioned({ features: { barrel: false } }).compile(spec);
    expect(outputs["models/index.ts"]).toBeUndefined();
    expect(outputs["models/api-version.ts"]).toBe(`${HEADER}

/** Version of the PetStore API this code was generated for. */
export const API_VERSION = "2024-06-01";
`);
  });

  it("emits the version chosen by the version option", async () => {
    const { outputs } = await versioned({ version: "2024-01-01" }).compile(spec);
    expect(outputs["models/Toy.ts"]).toBeUndefined();
    expect(outputs["models/index.ts"]).toContain(`export const API_VERSION = "2024-01-01";`);
    expect(outputs["models/Pet.ts"]).toContain(`export interface Pet {
  id: number;
  title: string;
  tag: string;
}`);
  });

  it("appends the constants to types.ts in the single-file layout", async () => {
    const { outputs } = await versioned({ layout: "single-file" }).compile(`
      @service @versioned(AV) namespace Alpha { enum AV { v1: "a1" } model A { a: string } }
      @service @versioned(BV) namespace Beta { enum BV { v1: "b1", v2: "b2" } }
    `);
    expect(outputs["types.ts"]).toMatch(
      /export interface A \{\n  a: string;\n\}\n\n\/\*\* Version of the Alpha API this code was generated for. \*\/\nexport const ALPHA_API_VERSION = "a1";\n\n\/\*\* Version of the Beta API this code was generated for. \*\/\nexport const BETA_API_VERSION = "b2";\n$/,
    );
  });

  it("emits the barrel for the constant alone", async () => {
    const { outputs } = await versioned().compile(`@service @versioned(V) namespace S; enum V { v1 }`);
    expect(outputs["models/index.ts"]).toBe(`${HEADER}

/** Version of the S API this code was generated for. */
export const API_VERSION = "v1";
`);
  });

  it("does not clash with a version enum named ApiVersion used as a parameter", async () => {
    const [{ outputs }, diagnostics] = await versioned().compileAndDiagnose(`
      @service @versioned(ApiVersion) namespace PetStore;
      enum ApiVersion { v2024: "2024-01-01", v2025: "2025-01-01" }
      model Pet { id: int64 }
      @route("/pets") op list(@query("api-version") apiVersion: ApiVersion): Pet[];
    `);
    expect(diagnostics).toEqual([]);
    expect(outputs["models/ApiVersion.ts"]).toContain("export type ApiVersion");
    expect(outputs["models/index.ts"]).toContain(`export const API_VERSION = "2025-01-01";`);
  });

  for (const layout of ["per-type", "single-file"]) {
    it(`reports a generated type named like the constant instead of shadowing it (${layout})`, async () => {
      const [{ outputs }, diagnostics] = await versioned({ layout }).compileAndDiagnose(`
        @service @versioned(V) namespace S;
        enum V { v1 }
        @TS.name("API_VERSION") model Version { a: string }
      `);
      expectDiagnostics(diagnostics, {
        code: "@abhigyakrishna/tspgen-typescript/api-version-name-clash",
        message:
          "Generated type 'API_VERSION' (S.Version) has the name of the version constant 'API_VERSION'; rename it with @TS.name. The constant is not generated.",
      });
      const file = outputs[layout === "per-type" ? "models/index.ts" : "types.ts"];
      expect(file).not.toContain("export const API_VERSION");
    });
  }

  it("emits no constant for unversioned services", async () => {
    const { outputs } = await emitter().compile(`@service namespace S; model M { a: string }`);
    expect(outputs["models/index.ts"]).toBe(`${HEADER}

export * from "./M";
`);
  });
});
