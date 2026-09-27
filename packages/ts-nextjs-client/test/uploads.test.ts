import { expectDiagnostics } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { nextjs } from "./tester.js";
import { typecheck } from "./typecheck.js";

const SHIPYARD_FLAGS = {
  exactOptionalPropertyTypes: true,
  noUncheckedIndexedAccess: true,
  noImplicitOverride: true,
  noFallthroughCasesInSwitch: true,
};

export const uploadSpec = `
  @service namespace Media;
  model Meta { title: string }
  model UploadRequest {
    name: HttpPart<string>;
    count?: HttpPart<int32>;
    meta: HttpPart<Meta>;
    avatar: HttpPart<File>;
    photos?: HttpPart<File<"image/png">>[];
    @encodedName("application/json", "display_name") displayName?: HttpPart<string, #{ name: "label" }>;
  }
  model Receipt { size: int32 }
  @route("/uploads") interface Uploads {
    @post upload(@header contentType: "multipart/form-data", @multipartBody body: UploadRequest): Receipt;
    @put @route("/file") file(@bodyRoot file: File<"image/png">): void;
    @put @route("/any") any(@bodyRoot file: File): void;
  }
`;

describe("uploads (grouped client)", () => {
  it("describes multipart parts and file bodies in the request spec", async () => {
    const { outputs } = await nextjs({}, { zod: true }).compile(uploadSpec);
    const group = outputs["client/uploads.ts"];
    expect(group).toContain(`        body: params.body,
        multipart: [{ name: "name", kind: "text", multi: false }, { name: "count", kind: "text", multi: false }, { name: "meta", kind: "json", multi: false }, { name: "avatar", kind: "file", multi: false }, { name: "photos", kind: "file", multi: true, contentType: "image/png" }, { name: "label", key: "display_name", kind: "text", multi: false }],
`);
    expect(group).toContain(`        body: params.file,
        file: true,
        contentType: "image/png",
`);
    expect(group).toContain(`        body: params.file,
        file: true,
      },`);
    expect(outputs["client/core.ts"]).toContain("export function toFormData(value: object, parts: readonly PartSpec[]): FormData {");
  });

  it("gives JSON parts their declared JSON content type, when not application/json", async () => {
    const spec = uploadSpec.replace(
      "  model Receipt",
      `  model VendorUpload { vendor: HttpPart<{ @header contentType: "application/vnd.meta+json"; @body body: Meta }>; plain: HttpPart<Meta> }
  @route("/vendor") @post op vendor(@header contentType: "multipart/form-data", @multipartBody body: VendorUpload): void;
  model Receipt`,
    );
    const expected = `[{ name: "vendor", kind: "json", multi: false, contentType: "application/vnd.meta+json" }, { name: "plain", kind: "json", multi: false }]`;
    const grouped = await nextjs({ "react-query": false, "server-actions": false }, { zod: true }).compile(spec);
    expect(grouped.outputs["client/media.ts"]).toContain(`multipart: ${expected},`);
    expect(grouped.outputs["client/core.ts"]).toContain(`new Blob([JSON.stringify(item)], { type: part.contentType ?? "application/json" })`);
    const flat = await nextjs({ "client-style": "flat" }, { layout: "single-file" }).compile(spec);
    expect(flat.outputs["client.ts"]).toContain(`new RawBody(toFormData(body, ${expected}))`);
    expect(flat.outputs["client.ts"]).toContain(`new globalThis.Blob([JSON.stringify(item)], { type: part.contentType ?? "application/json" })`);
  });

  it("does not warn about upload bodies and still skips them in hooks and actions", async () => {
    const [result, diagnostics] = await nextjs({}, { zod: true }).compileAndDiagnose(uploadSpec);
    expectDiagnostics(diagnostics, []);
    expect(result.outputs["client/react-query/hooks.ts"]).not.toContain("upload");
    expect(result.outputs["client/actions/uploads.ts"]).toBeUndefined();
  });

  it("skips JSON-typed file bodies in hooks and actions too", async () => {
    const spec = `@service namespace Media;
      @route("/docs") interface Docs {
        @put importDoc(@bodyRoot file: File<"application/json">): void;
        @post create(@body doc: { title: string }): void;
      }`;
    const [result, diagnostics] = await nextjs({}, { zod: true }).compileAndDiagnose(spec);
    expectDiagnostics(diagnostics, []);
    expect(result.outputs["client/docs.ts"]).toContain("file: true,");
    expect(result.outputs["client/react-query/hooks.ts"]).toContain("create");
    expect(result.outputs["client/react-query/hooks.ts"]).not.toContain("importDoc");
    expect(result.outputs["client/actions/docs.ts"]).toContain("create");
    expect(result.outputs["client/actions/docs.ts"]).not.toContain("importDoc");
  });

  it("keeps file fields DOM Blobs next to a generated type named Blob", async () => {
    const spec = `${uploadSpec}\nmodel Blob { id: string }\n@get @route("/blob") op blob(): Blob;`;
    for (const layout of ["single-file", "per-type"]) {
      const { outputs } = await nextjs({ "server-actions": false }, { zod: true, layout }).compile(spec);
      expect(typecheck(outputs, SHIPYARD_FLAGS)).toBe("");
    }
  });

  it("type-checks under shipyard's compiler flags", async () => {
    // Without the Server Actions (they read process.env, which needs @types/node).
    const { outputs } = await nextjs({ "server-actions": false }, { zod: true }).compile(uploadSpec);
    expect(typecheck(outputs, SHIPYARD_FLAGS)).toBe("");
  });
});

describe("uploads (flat client)", () => {
  const flat = { "client-style": "flat" };

  it("wraps upload bodies in RawBody and keeps JSON-only clients unchanged", async () => {
    const { outputs } = await nextjs(flat, { layout: "single-file" }).compile(uploadSpec);
    const client = outputs["client.ts"];
    expect(client).toContain(
      `    return this.send("POST", "/uploads", new RawBody(toFormData(body, [{ name: "name", kind: "text", multi: false }, { name: "count", kind: "text", multi: false }, { name: "meta", kind: "json", multi: false }, { name: "avatar", kind: "file", multi: false }, { name: "photos", kind: "file", multi: true, contentType: "image/png" }, { name: "label", key: "display_name", kind: "text", multi: false }])));`,
    );
    expect(client).toContain(`    await this.request("PUT", "/uploads/file", new RawBody(file, file.type || "image/png"));`);
    expect(client).toContain(`    await this.request("PUT", "/uploads/any", new RawBody(file, file.type || "application/octet-stream"));`);
    expect(client).toContain("class RawBody {");
    const plain = await nextjs(flat, { layout: "single-file" }).compile(`@service namespace S; model P { a: string } @post op make(@body p: P): P;`);
    expect(plain.outputs["client.ts"]).not.toContain("RawBody");
  });

  it("type-checks under shipyard's compiler flags, with and without validate", async () => {
    for (const options of [flat, { ...flat, validate: true }]) {
      const { outputs } = await nextjs(options, { layout: "single-file", zod: true }).compile(uploadSpec);
      expect(typecheck(outputs, SHIPYARD_FLAGS)).toBe("");
    }
  });

  it.each(["Blob", "FormData"])("works with a generated type named %s (globals are read through globalThis)", async (name) => {
    const spec = `${uploadSpec}\nmodel ${name} { x: string }\n@route("/named") @get op readNamed(): ${name};`;
    const { outputs } = await nextjs(flat, { layout: "single-file", zod: true }).compile(spec);
    expect(outputs["client.ts"]).toContain(`import type { ${name}, `);
    expect(typecheck(outputs, SHIPYARD_FLAGS)).toBe("");
  });

  it.each(["BodyInit", "PartSpec", "RawBody", "toFormData"])("reports a generated type named like the upload global %s", async (name) => {
    const [result, diagnostics] = await nextjs(flat, { layout: "single-file" }).compileAndDiagnose(
      `using TspGen;\n${uploadSpec}\n@TS.name("${name}") model Clash { x: string }`,
    );
    expectDiagnostics(diagnostics, {
      code: "@abhigyakrishna/tspgen-typescript/flat-client-name-clash",
      message: `Generated type '${name}' clashes with a name the flat client uses internally ('${name}'); rename it with @TS.name.`,
    });
    expect(result.outputs["client.ts"]).toBeUndefined();
  });
});
