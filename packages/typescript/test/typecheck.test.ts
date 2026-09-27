import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { emitter } from "./tester.js";

const TSC = resolve(import.meta.dirname, "../../../node_modules/.bin/tsc");
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Writes generated files into a temp dir inside this package (so `zod` resolves) and runs tsc. */
function typecheck(outputs: Record<string, string>): string {
  const dir = mkdtempSync(join(resolve(import.meta.dirname, ".."), ".tmp-tsc-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(outputs)) {
    if (!path.endsWith(".ts")) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "es2022",
        module: "esnext",
        moduleResolution: "bundler",
        verbatimModuleSyntax: true,
        skipLibCheck: true,
      },
      include: ["**/*.ts"],
    }),
  );
  try {
    return execFileSync(TSC, ["-p", dir], { encoding: "utf8" });
  } catch (error) {
    return String((error as { stdout?: string }).stdout ?? error);
  }
}

describe("generated TypeScript", () => {
  it("type-checks with zod schemas, discriminated unions, results and errors", async () => {
    const { outputs } = await emitter({ zod: true }).compile(`
      @service namespace PetStore;
      model Pet {
        id: int64;
        name?: string;
        born_at: utcDateTime;
        species: Species;
        owner: Owner | null;
        toys: Toy[];
        parent?: Pet;
      }
      model Owner { name: string }
      enum Species { dog, cat }
      enum Level { low: 1, high: 2 }
      union Loose { "a", string }
      @discriminator("kind") model Toy { kind: string; name: string }
      model Ball extends Toy { kind: "ball"; diameter: float32 }
      model Rope extends Toy { kind: "rope"; length: int32 }
      model Cat { lives: int32 }
      model Dog { barks: boolean }
      @discriminated(#{ envelope: "none", discriminatorPropertyName: "type" }) union Animal { cat: Cat, dog: Dog }
      @discriminated union Wrapped { cat: Cat, dog: Dog }
      @error model NotFound { @statusCode _: 404; message: string }
      @route("/pets") interface Pets {
        @post create(@body pet: Pet): { @statusCode _: 201; @header location: string; @body pet: Pet } | { @statusCode _: 200; @body pet: Pet } | NotFound;
      }
    `);
    expect(typecheck(outputs)).toBe("");
  });

  it("type-checks generic models and their zod schema functions", async () => {
    for (const layout of ["per-type", "single-file"]) {
      const { outputs } = await emitter({ zod: true, layout }).compile(`
        @service namespace Shop;
        model Page<T> { items: T[]; total: int64; next?: T }
        model Pair<K, V> { key: K; value: V; pages: Page<V>[] }
        model Pet { id: int64 }
        @route("/pets") interface Pets {
          @get list(): Page<Pet>;
          @get @route("/pairs") pairs(): Pair<string, Page<Pet>>;
        }
      `);
      expect(typecheck(outputs)).toBe("");
    }
  });
});
