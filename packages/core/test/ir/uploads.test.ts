import { expectDiagnostics } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { buildApiIR } from "../../src/index.js";
import { Tester } from "../tester.js";

const spec = `
  @service namespace S;
  model Meta { title: string }
  enum Kind { a, b }
  model Png extends File<"image/png"> {}
  model UploadRequest {
    /** Display name */
    name: HttpPart<string>;
    count?: HttpPart<int32>;
    kind: HttpPart<Kind>;
    meta: HttpPart<Meta>;
    tags: HttpPart<string>[];
    avatar: HttpPart<File>;
    photos: HttpPart<Png>[];
    doc?: HttpPart<File<"application/pdf" | "text/plain">>;
    renamed: HttpPart<string, #{ name: "other" }>;
  }
  @route("/u") interface U {
    @post upload(@header contentType: "multipart/form-data", @multipartBody body: UploadRequest): void;
    @post @route("raw") raw(@bodyRoot file: File): void;
    @post @route("png") png(@bodyRoot file: Png): void;
    @post @route("txt") txt(@bodyRoot file: File<"text/plain", string>): void;
  }
`;

describe("multipart and file bodies", () => {
  it("builds parts of a model-form multipart body", async () => {
    const { program } = await Tester.compile(spec);
    const [upload] = buildApiIR(program).services[0].groups[0].operations;
    expect(upload.params).toEqual([]);
    expect(upload.body).toEqual({
      name: "body",
      type: { kind: "named", id: "S.UploadRequest" },
      contentTypes: ["multipart/form-data"],
      optional: false,
      kind: "multipart",
      parts: [
        {
          name: "name",
          property: "name",
          optional: false,
          multi: false,
          kind: "text",
          type: { kind: "scalar", name: "string" },
          contentTypes: ["text/plain"],
          docs: "Display name",
        },
        { name: "count", property: "count", optional: true, multi: false, kind: "text", type: { kind: "scalar", name: "int32" }, contentTypes: ["text/plain"] },
        { name: "kind", property: "kind", optional: false, multi: false, kind: "text", type: { kind: "named", id: "S.Kind" }, contentTypes: ["application/json"] },
        { name: "meta", property: "meta", optional: false, multi: false, kind: "json", type: { kind: "named", id: "S.Meta" }, contentTypes: ["application/json"] },
        { name: "tags", property: "tags", optional: false, multi: true, kind: "text", type: { kind: "scalar", name: "string" }, contentTypes: ["text/plain"] },
        { name: "avatar", property: "avatar", optional: false, multi: false, kind: "file", type: { kind: "file" }, contentTypes: [] },
        { name: "photos", property: "photos", optional: false, multi: true, kind: "file", type: { kind: "file" }, contentTypes: ["image/png"] },
        {
          name: "doc",
          property: "doc",
          optional: true,
          multi: false,
          kind: "file",
          type: { kind: "file" },
          contentTypes: ["application/pdf", "text/plain"],
        },
        { name: "other", property: "renamed", optional: false, multi: false, kind: "text", type: { kind: "scalar", name: "string" }, contentTypes: ["text/plain"] },
      ],
    });
  });

  it("reads a part declared with an envelope as the envelope's body, with its content type", async () => {
    const { program } = await Tester.compile(`
      @service namespace S;
      model Meta { title: string }
      model Form {
        avatarMeta: HttpPart<{ @header contentType: "application/vnd.x+json"; @body body: Meta }>;
        rootMeta?: HttpPart<{ @header contentType: "application/merge-patch+json"; @bodyRoot value: Meta }>;
        avatar: HttpPart<{ @header contentType: "image/png"; @body body: bytes }>;
      }
      @post op send(@header contentType: "multipart/form-data", @multipartBody body: Form): void;
    `);
    const ir = buildApiIR(program);
    const [send] = ir.services[0].groups[0].operations;
    expect(send.body?.parts).toEqual([
      { name: "avatarMeta", property: "avatarMeta", optional: false, multi: false, kind: "json", type: { kind: "named", id: "S.Meta" }, contentTypes: ["application/vnd.x+json"] },
      { name: "rootMeta", property: "rootMeta", optional: true, multi: false, kind: "json", type: { kind: "named", id: "S.Meta" }, contentTypes: ["application/merge-patch+json"] },
      { name: "avatar", property: "avatar", optional: false, multi: false, kind: "file", type: { kind: "file" }, contentTypes: ["image/png"] },
    ]);
    const form = ir.types.find((t) => t.id === "S.Form");
    expect(form?.kind === "model" && form.properties.map((p) => [p.name, p.type])).toEqual([
      ["avatarMeta", { kind: "named", id: "S.Meta" }],
      ["rootMeta", { kind: "named", id: "S.Meta" }],
      ["avatar", { kind: "file" }],
    ]);
    expect(ir.types.map((t) => t.id)).toEqual(["S.Form", "S.Meta"]);
  });

  it("unwraps HttpPart and maps Http.File to the file TypeRef in the body model", async () => {
    const { program } = await Tester.compile(spec);
    const ir = buildApiIR(program);
    const model = ir.types.find((t) => t.id === "S.UploadRequest");
    expect(model?.kind === "model" && model.properties.map((p) => [p.name, p.type])).toEqual([
      ["name", { kind: "scalar", name: "string" }],
      ["count", { kind: "scalar", name: "int32" }],
      ["kind", { kind: "named", id: "S.Kind" }],
      ["meta", { kind: "named", id: "S.Meta" }],
      ["tags", { kind: "array", of: { kind: "scalar", name: "string" } }],
      ["avatar", { kind: "file" }],
      ["photos", { kind: "array", of: { kind: "file" } }],
      ["doc", { kind: "file" }],
      ["renamed", { kind: "scalar", name: "string" }],
    ]);
    expect(ir.types.map((t) => t.id)).toEqual(["S.Kind", "S.Meta", "S.UploadRequest"]);
  });

  it("builds file bodies", async () => {
    const { program } = await Tester.compile(spec);
    const [, raw, png, txt] = buildApiIR(program).services[0].groups[0].operations;
    expect(raw.body).toEqual({
      name: "file",
      type: { kind: "file" },
      contentTypes: ["*/*"],
      optional: false,
      kind: "file",
      file: { isText: false, contentTypes: [] },
    });
    expect(png.body?.file).toEqual({ isText: false, contentTypes: ["image/png"] });
    expect(txt.body?.file).toEqual({ isText: true, contentTypes: ["text/plain"] });
  });

  it("keeps the content-type header parameter of JSON bodies", async () => {
    const { program } = await Tester.compile(`
      @service namespace S;
      model Pet { name: string }
      @post op create(@header contentType: "application/json", @body pet: Pet): void;
    `);
    const [op] = buildApiIR(program).services[0].groups[0].operations;
    expect(op.params.map((p) => p.wireName)).toEqual(["Content-Type"]);
  });

  it("reports tuple-form multipart bodies and skips the operation", async () => {
    const { program } = await Tester.compile(`
      @service namespace S;
      @route("/t") interface T {
        @post tuple(@header contentType: "multipart/form-data", @multipartBody body: [HttpPart<string, #{ name: "a" }>]): void;
        @get ok(): void;
      }
    `);
    const ir = buildApiIR(program);
    expectDiagnostics(program.diagnostics, {
      code: "@abhigyakrishna/tspgen-core/unsupported-multipart-tuple",
      message: /Operation 'S\.T\.tuple' uses a tuple-form @multipartBody/,
    });
    expect(ir.services[0].groups[0].operations.map((o) => o.name)).toEqual(["ok"]);
  });
});

describe("part classification", () => {
  const partsOf = async (models: string, body: string) => {
    const { program } = await Tester.compile(`
      @service namespace S;
      ${models}
      model Up { ${body} }
      @post op upload(@header contentType: "multipart/form-data", @multipartBody body: Up): void;
    `);
    const ir = buildApiIR(program);
    return { ir, program, parts: ir.services[0].groups[0].operations[0].body!.parts! };
  };

  it("treats HttpPart<bytes> as a file part", async () => {
    const { ir, parts } = await partsOf("", "blob: HttpPart<bytes>; blobs?: HttpPart<bytes>[];");
    expect(parts.map((p) => [p.name, p.kind, p.type])).toEqual([
      ["blob", "file", { kind: "file" }],
      ["blobs", "file", { kind: "file" }],
    ]);
    const model = ir.types.find((t) => t.id === "S.Up");
    expect(model?.kind === "model" && model.properties.map((p) => p.type)).toEqual([
      { kind: "file" },
      { kind: "array", of: { kind: "file" } },
    ]);
  });

  it("classifies JSON parts of unions, nullable models, arrays and records as json; scalars, enums, literals as text", async () => {
    const { parts } = await partsOf(
      "model Cat { a: string } model Dog { b: string } enum Kind { x, y }",
      `pet: HttpPart<Cat | Dog>;
       meta: HttpPart<Cat | null>;
       list: HttpPart<string[]>;
       map: HttpPart<Record<int32>>;
       tuple: HttpPart<[string, int32]>;
       kind: HttpPart<Kind>;
       lit: HttpPart<"a" | "b">;
       n: HttpPart<int32 | null>;
       s: HttpPart<string>;`,
    );
    expect(Object.fromEntries(parts.map((p) => [p.name, p.kind]))).toEqual({
      pet: "json",
      meta: "json",
      list: "json",
      map: "json",
      tuple: "json",
      kind: "text",
      lit: "text",
      n: "text",
      s: "text",
    });
  });
});

describe("upload diagnostics", () => {
  it("reports a multipart body model extending a base with parts and skips the operation", async () => {
    const { program } = await Tester.compile(`
      @service namespace S;
      model Base { f: HttpPart<File>; }
      model Up extends Base { n: HttpPart<string>; }
      model Spread { ...Base; n: HttpPart<string>; }
      @route("/t") interface T {
        @post @route("up") up(@header contentType: "multipart/form-data", @multipartBody body: Up): void;
        @post @route("sp") sp(@header contentType: "multipart/form-data", @multipartBody body: Spread): void;
      }
    `);
    const ir = buildApiIR(program);
    expectDiagnostics(program.diagnostics, {
      code: "@abhigyakrishna/tspgen-core/unsupported-multipart-base",
      message: /'S\.Up' .*extends 'S\.Base'.*\.\.\.Base/,
    });
    expect(ir.services[0].groups[0].operations.map((o) => o.name)).toEqual(["sp"]);
    const multipart = ir.types.filter((t) => t.kind === "model" && t.multipart).map((t) => t.id);
    expect(multipart).toEqual(["S.Base", "S.Spread", "S.Up"]);
  });

  it("warns about Http.File in JSON models and responses", async () => {
    const { program } = await Tester.compile(`
      @service namespace S;
      model Doc { title: string; file: File; }
      model Up { f: HttpPart<File>; }
      @route("/t") interface T {
        @post @route("a") a(@body doc: Doc): void;
        @get @route("b") b(): File;
        @post @route("c") c(@header contentType: "multipart/form-data", @multipartBody body: Up): void;
      }
    `);
    buildApiIR(program);
    expectDiagnostics(program.diagnostics, [
      { code: "@abhigyakrishna/tspgen-core/file-in-json", severity: "warning", message: /Model 'S\.Doc'/ },
      { code: "@abhigyakrishna/tspgen-core/file-in-json", severity: "warning", message: /Operation 'S\.T\.b'/ },
    ]);
  });

  it("reports nothing for well-formed uploads", async () => {
    const { program } = await Tester.compile(spec);
    buildApiIR(program);
    expect(program.diagnostics).toEqual([]);
  });

  it("warns when a multipart model is also used as JSON", async () => {
    const { program } = await Tester.compile(`
      @service namespace S;
      model Up { n: HttpPart<string>; }
      @route("/t") interface T {
        @post @route("c") c(@header contentType: "multipart/form-data", @multipartBody body: Up): Up;
      }
    `);
    buildApiIR(program);
    expectDiagnostics(program.diagnostics, {
      code: "@abhigyakrishna/tspgen-core/multipart-model-in-json",
      severity: "warning",
      message: /'S\.Up'.*'S\.T\.c'/,
    });
  });
});
