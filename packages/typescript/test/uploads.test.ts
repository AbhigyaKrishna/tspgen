import { buildApiIR } from "@abhigyakrishna/tspgen-core";
import { describe, expect, it } from "vitest";
import { transformToTs } from "../src/transform/index.js";
import { emitter, HEADER, Tester } from "./tester.js";

const spec = `
  @service namespace S;
  model Meta { title: string }
  model UploadRequest {
    name: HttpPart<string>;
    meta?: HttpPart<Meta>;
    avatar: HttpPart<File>;
    photos: HttpPart<File<"image/png">>[];
    @encodedName("application/json", "display_name") displayName?: HttpPart<string, #{ name: "label" }>;
  }
  @route("/u") interface U {
    @post upload(@header contentType: "multipart/form-data", @multipartBody body: UploadRequest): void;
    @put @route("/f") file(@bodyRoot file: File<"image/png">): void;
  }
`;

describe("typescript uploads", () => {
  it("maps Http.File to globalThis.Blob with an instanceof schema", async () => {
    const { outputs } = await emitter({ zod: true }).compile(spec);
    expect(outputs["models/UploadRequest.ts"]).toBe(`${HEADER}
import { z } from "zod";
import { MetaSchema } from "./Meta";
import type { Meta } from "./Meta";

export interface UploadRequest {
  name: string;
  meta?: Meta;
  avatar: globalThis.Blob;
  photos: globalThis.Blob[];
  display_name?: string;
}

export const UploadRequestSchema: z.ZodType<UploadRequest> = z.object({
  name: z.string(),
  meta: z.lazy(() => MetaSchema).exactOptional(),
  avatar: z.instanceof(globalThis.Blob),
  photos: z.array(z.instanceof(globalThis.Blob)),
  display_name: z.string().exactOptional(),
});
`);
  });

  it("describes multipart parts and file bodies on the operation", async () => {
    const { program } = await Tester.compile(spec);
    const ir = transformToTs(program, buildApiIR(program), { zod: true, importExtension: "" });
    const [upload, file] = ir.services[0].groups[0].operations;
    expect(upload.params).toEqual([]);
    expect(upload.body).toMatchObject({ name: "body", kind: "multipart", contentType: "multipart/form-data" });
    expect(upload.body?.parts?.map((p) => [p.name, p.key, p.kind, p.multi, p.optional, p.type.text])).toEqual([
      ["name", "name", "text", false, false, "string"],
      ["meta", "meta", "json", false, true, "Meta"],
      ["avatar", "avatar", "file", false, false, "globalThis.Blob"],
      ["photos", "photos", "file", true, false, "globalThis.Blob"],
      ["label", "display_name", "text", false, true, "string"],
    ]);
    expect(file.body).toMatchObject({ name: "file", kind: "file", type: { text: "globalThis.Blob" }, file: { isText: false, contentTypes: ["image/png"] } });
  });
});
