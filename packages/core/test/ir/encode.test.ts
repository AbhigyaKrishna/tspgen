import { expectDiagnostics } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { buildApiIR, type ModelIR } from "../../src/index.js";
import { Tester } from "../tester.js";

function model(ir: ReturnType<typeof buildApiIR>, id: string): ModelIR {
  const found = ir.types.find((t) => t.id === id);
  if (found?.kind !== "model") throw new Error(`no model ${id}`);
  return found;
}

describe("@encode", () => {
  it("records @encode(string) on string-encodable numbers from properties, scalars and parameters", async () => {
    const { program } = await Tester.compile(`
      @service namespace S;
      @encode(string) scalar BigId extends int64;
      scalar Amount extends decimal;
      model M {
        @encode(string) id: int64;
        @encode(string) total?: uint64;
        big: BigId;
        ids: BigId[];
        @encode(string) amount: Amount;
        @encode(string) exact: decimal128;
        plain: int64;
      }
      @route("/m/{id}") op get(@path @encode(string) id: int64, @header @encode(string) count: safeint): M;
    `);
    const ir = buildApiIR(program);
    const big = { kind: "scalar", name: "int64", custom: expect.objectContaining({ id: "S.BigId" }), encoding: "string" };
    expect(model(ir, "S.M").properties.map((p) => p.type)).toEqual([
      { kind: "scalar", name: "int64", encoding: "string" },
      { kind: "scalar", name: "uint64", encoding: "string" },
      big,
      { kind: "array", of: big },
      { kind: "scalar", name: "decimal", custom: expect.objectContaining({ id: "S.Amount" }), encoding: "string" },
      { kind: "scalar", name: "decimal128", encoding: "string" },
      { kind: "scalar", name: "int64" },
    ]);
    const [op] = ir.services[0].groups[0].operations;
    expect(op.params.map((p) => p.type)).toEqual([
      { kind: "scalar", name: "int64", encoding: "string" },
      { kind: "scalar", name: "safeint", encoding: "string" },
    ]);
    expect(program.diagnostics).toEqual([]);
  });

  it("warns once per declaration on other encodings and accepts default JSON encodings silently", async () => {
    const { program } = await Tester.compile(`
      @service namespace S;
      @encode("unixTimestamp", int32) scalar Stamp extends utcDateTime;
      model M {
        @encode("rfc7231") at: utcDateTime;
        @encode("rfc3339") iso: utcDateTime;
        @encode("base64") data: bytes;
        @encode(string) flag: boolean;
        first: Stamp;
        second: Stamp;
      }
    `);
    const ir = buildApiIR(program);
    const stamp = { kind: "scalar", name: "utcDateTime", custom: expect.objectContaining({ id: "S.Stamp" }) };
    expect(model(ir, "S.M").properties.map((p) => p.type)).toEqual([
      { kind: "scalar", name: "utcDateTime" },
      { kind: "scalar", name: "utcDateTime" },
      { kind: "scalar", name: "bytes" },
      { kind: "scalar", name: "boolean" },
      stamp,
      stamp,
    ]);
    expectDiagnostics(
      program.diagnostics.filter((d) => d.code.endsWith("unsupported-encoding")),
      [
        {
          code: "@abhigyakrishna/tspgen-core/unsupported-encoding",
          message: `@encode("rfc7231") on 'S.M.at' is not supported; the default JSON encoding is used.`,
        },
        {
          code: "@abhigyakrishna/tspgen-core/unsupported-encoding",
          message: `@encode("string") on 'S.M.flag' is not supported; the default JSON encoding is used.`,
        },
        {
          code: "@abhigyakrishna/tspgen-core/unsupported-encoding",
          message: `@encode("unixTimestamp") on 'S.Stamp' is not supported; the default JSON encoding is used.`,
        },
      ],
    );
  });

  it("reports unsupported-encoding for @encode on a union-typed property instead of dropping it silently", async () => {
    const { program } = await Tester.compile(`
      @service namespace S;
      union Foo { x: int64 }
      model M {
        @encode(string) mixed: int64 | string;
        @encode(string) namedUnion: Foo | null;
      }
    `);
    const ir = buildApiIR(program);
    const types = model(ir, "S.M").properties.map((p) => p.type);
    expect(types).toEqual([
      { kind: "named", id: "$anon.MMixed" },
      { kind: "nullable", of: { kind: "named", id: "S.Foo" } },
    ]);
    expectDiagnostics(
      program.diagnostics.filter((d) => d.code.endsWith("unsupported-encoding")),
      [
        {
          code: "@abhigyakrishna/tspgen-core/unsupported-encoding",
          message: `@encode("string") on 'S.M.mixed' is not supported; the default JSON encoding is used.`,
        },
        {
          code: "@abhigyakrishna/tspgen-core/unsupported-encoding",
          message: `@encode("string") on 'S.M.namedUnion' is not supported; the default JSON encoding is used.`,
        },
      ],
    );
  });

  it("warns once per declaration even when the @encode property is spread or template-instantiated repeatedly", async () => {
    const { program } = await Tester.compile(`
      @service namespace S;
      model Base { @encode("rfc7231") at: utcDateTime; }
      model M { ...Base; }
      model N { ...Base; }
      model Container<T> { @encode("rfc7231") stamp: utcDateTime; value: T; }
      model Holder { a: Container<string>; b: Container<int32>; }
    `);
    // generics: false forces each template use to be collected as its own model, so `stamp` is processed once
    // per instance (rather than once for a single shared generic Container model).
    buildApiIR(program, { generics: false });
    const warnings = program.diagnostics.filter((d) => d.code.endsWith("unsupported-encoding"));
    // One for Base.at (covering both M and N's spread copies), one for Container.stamp (covering both instances).
    expect(warnings).toHaveLength(2);
  });

  it("applies @encode on an explicit @body property", async () => {
    const { program } = await Tester.compile(`
      @service namespace S;
      @route("/b") op setAmount(@body @encode(string) amount: int64): void;
    `);
    const ir = buildApiIR(program);
    const [setAmount] = ir.services[0].groups[0].operations;
    expect(setAmount.body?.type).toEqual({ kind: "scalar", name: "int64", encoding: "string" });
    expect(program.diagnostics.filter((d) => d.code.endsWith("unsupported-encoding"))).toEqual([]);
  });

  it("examines a multipart part property's own @encode instead of ignoring it", async () => {
    // `@encode` can only target a numeric/boolean/date/duration/bytes type (TypeSpec's own `$encode` validates
    // this); a multipart part's declared type is always `HttpPart<T>` (a model), so a recognized encoding can
    // never be written directly on the part property. An unrecognized encoding string skips that validation, so
    // it is the only way to prove the part property's own `@encode` is now examined (not silently dropped by
    // `collector.ref`, which never looked at the property's decorators at all).
    const { program } = await Tester.compile(`
      @service namespace S;
      model UploadRequest {
        @encode("custom") count: HttpPart<int64>;
      }
      @route("/u") op upload(@header contentType: "multipart/form-data", @multipartBody body: UploadRequest): void;
    `);
    const ir = buildApiIR(program);
    const [upload] = ir.services[0].groups[0].operations;
    expect(upload.body?.parts?.[0].type).toEqual({ kind: "scalar", name: "int64" });
    expectDiagnostics(
      program.diagnostics.filter((d) => d.code.endsWith("unsupported-encoding")),
      [
        {
          code: "@abhigyakrishna/tspgen-core/unsupported-encoding",
          message: `@encode("custom") on 'S.UploadRequest.count' is not supported; the default JSON encoding is used.`,
        },
      ],
    );
  });
});
