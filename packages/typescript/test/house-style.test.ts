import { expectDiagnostics } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { emitter } from "./tester.js";

const petErrors = `
  @service namespace S;
  model Pet { id: string }
  @error model NotFound { @statusCode _: 404; message: string }
  @route("/pets") interface Pets { @get read(@path id: string): Pet | NotFound; }
`;

describe("typescript house-style options", () => {
  it("errors: thrown generates no typed error classes", async () => {
    const thrown = await emitter({ errors: "thrown" }).compile(petErrors);
    expect(thrown.outputs["api/errors.ts"]).toContain("export class HttpError extends Error");
    expect(thrown.outputs["api/errors.ts"]).not.toContain("NotFoundError");

    const typed = await emitter().compile(petErrors);
    expect(typed.outputs["api/errors.ts"]).toContain("export class NotFoundError extends HttpError");
  });

  it("accepts layout and rejects unknown values", async () => {
    await emitter({ layout: "per-type" }).compile(petErrors);
    const [, diagnostics] = await emitter({ layout: "sideways" }).compileAndDiagnose(petErrors);
    expect(diagnostics.some((d) => d.code === "invalid-schema")).toBe(true);
  });

  it("layout: single-file writes every model to types.ts under namespace banners", async () => {
    const { outputs } = await emitter({ layout: "single-file" }).compile(`
      @service namespace S;
      namespace Graph {
        enum Kind { DATABASE, QUEUE }
        model Node { id: string; kind: Kind }
      }
      namespace Iam { model User { name: string; node?: Graph.Node } }
    `);
    expect(Object.keys(outputs).filter((k) => k.endsWith(".ts"))).toEqual(["types.ts"]);
    const types = outputs["types.ts"];
    expect(types).not.toContain("import ");
    expect(types).toMatch(/^\/\/ ── S\.Graph ─+$/m);
    expect(types).toMatch(/^\/\/ ── S\.Iam ─+$/m);
    expect(types.indexOf("S.Graph ─")).toBeLessThan(types.indexOf("export interface Node {"));
    expect(types.indexOf("export interface Node {")).toBeLessThan(types.indexOf("S.Iam ─"));
    expect(types).toContain('export type Kind = "DATABASE" | "QUEUE";');
    expect(types).toContain("  node?: Node;");
    for (const line of types.split("\n").filter((l) => l.startsWith("// ──"))) expect(line.length).toBe(80);
  });

  it("api files import single-file types from ../types", async () => {
    const { outputs } = await emitter({ layout: "single-file" }).compile(petErrors);
    expect(outputs["api/errors.ts"]).toContain('import type { NotFound } from "../types";');
  });

  it("maps templated models with @TS.type and emits const tuples for enums with @meta values", async () => {
    const { outputs } = await emitter({ layout: "single-file" }).compile(`
      using Specgen;
      @service namespace S;
      model Page<T> { items: T[]; total: int64 }
      enum Kind { a: "A", b: "B" }
      model Node { id: string; kind: Kind }
      model Holder { page: Page<Node>; nested: Page<Page<Node>> }
      @@TS.type(S.Page, "Page", "../page");
      @@meta(S.Kind, "typescript", #{ values: "KINDS" });
    `);
    const types = outputs["types.ts"];
    expect(types).toContain('import type { Page } from "../page";');
    expect(types).toContain("  page: Page<Node>;");
    expect(types).toContain("  nested: Page<Page<Node>>;");
    expect(types).not.toMatch(/interface Page/);
    expect(types).toContain('export const KINDS = ["A", "B"] as const;\n\nexport type Kind = (typeof KINDS)[number];');
  });

  it("keeps the literal union for enums without values", async () => {
    const { outputs } = await emitter().compile(`@service namespace S; enum Kind { a: "A", b: "B" }`);
    expect(outputs["models/Kind.ts"]).toContain('export type Kind = "A" | "B";');
  });

  it("resolves relative @TS.type modules from the output root, rebased per file depth", async () => {
    const { outputs } = await emitter({ layout: "single-file" }).compile(`
      using Specgen;
      @service namespace S;
      model Page<T> { items: T[]; total: int64 }
      model Node { id: string }
      model Holder { page: Page<Node> }
      @@TS.type(S.Page, "Page", "../page");
      @route("/nodes") interface Nodes {
        @get list(): { @statusCode _: 200; @body page: Page<Node> } | { @statusCode _: 201; @body page: Page<Node> };
      }
    `);
    expect(outputs["types.ts"]).toContain('import type { Page } from "../page";');
    expect(outputs["api/results.ts"]).toContain('import type { Page } from "../../page";');
  });

  it("ignores an invalid values identifier and reports invalid-meta", async () => {
    const [invalidIdent, notIdentDiagnostics] = await emitter().compileAndDiagnose(`
      using Specgen;
      @service namespace S;
      enum Kind { a: "A", b: "B" }
      @@meta(S.Kind, "typescript", #{ values: "not an identifier" });
    `);
    expectDiagnostics(notIdentDiagnostics, {
      code: "@specgen/emitter-core/invalid-meta",
      message: /'values'.*must be an identifier different from the enum name/,
    });
    expect(invalidIdent.outputs["models/Kind.ts"]).toContain('export type Kind = "A" | "B";');

    const [ownName, sameNameDiagnostics] = await emitter().compileAndDiagnose(`
      using Specgen;
      @service namespace S;
      enum Kind { a: "A", b: "B" }
      @@meta(S.Kind, "typescript", #{ values: "Kind" });
    `);
    expectDiagnostics(sameNameDiagnostics, {
      code: "@specgen/emitter-core/invalid-meta",
      message: /'values'.*must be an identifier different from the enum name/,
    });
    expect(ownName.outputs["models/Kind.ts"]).toContain('export type Kind = "A" | "B";');
  });

  it("ignores a values identifier that is a reserved word and reports invalid-meta", async () => {
    const [result, diagnostics] = await emitter().compileAndDiagnose(`
      using Specgen;
      @service namespace S;
      enum Kind { a: "A", b: "B" }
      @@meta(S.Kind, "typescript", #{ values: "class" });
    `);
    expectDiagnostics(diagnostics, {
      code: "@specgen/emitter-core/invalid-meta",
      message: /'values'.*must be an identifier different from the enum name or a reserved word/,
    });
    expect(result.outputs["models/Kind.ts"]).toContain('export type Kind = "A" | "B";');
  });
});
