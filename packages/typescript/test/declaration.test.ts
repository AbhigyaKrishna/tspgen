import { afterAll, describe, expect, it } from "vitest";
import { emitter } from "./tester.js";
import { cleanup, tsc } from "./tsc.js";

afterAll(cleanup);

const spec = `
  using TspGen;
  @service namespace S;
  model Owner { name: string }
  model Page<T> { items: T[]; total: int32 }
  @meta("typescript", #{ supertypes: #[#{ name: "Owner", from: "./Owner" }] })
  model Pet { id: int64; page?: Page<Owner> }
  model Empty {}
`;

describe("declaration", () => {
  it("interface (default) is unchanged", async () => {
    const { outputs } = await emitter().compile(spec);
    expect(outputs["models/Owner.ts"]).toContain("export interface Owner {\n  name: string;\n}");
    expect(outputs["models/Pet.ts"]).toContain("export interface Pet extends Owner {");
  });

  it("type emits type aliases: plain, generic and intersections for supertypes", async () => {
    const { outputs } = await emitter({ declaration: "type", features: { zod: true } }).compile(spec);
    expect(outputs["models/Owner.ts"]).toContain(`export type Owner = {
  name: string;
};

export const OwnerSchema: z.ZodType<Owner> = z.object({
  name: z.string(),
});`);
    expect(outputs["models/Page.ts"]).toContain(`export type Page<T> = {
  items: T[];
  total: number;
};`);
    expect(outputs["models/Pet.ts"]).toContain(`export type Pet = Owner & {
  id: number;
  page?: Page<Owner>;
};`);
    expect(outputs["models/Pet.ts"]).toContain("}).loose() as unknown as z.ZodType<Pet>;");
    expect(outputs["models/Empty.ts"]).toContain("export type Empty = {\n};");
    expect(tsc(outputs)).toBe("");
  });

  it("type applies to the single-file layout", async () => {
    const { outputs } = await emitter({ declaration: "type", layout: "single-file" }).compile(spec);
    expect(outputs["types.ts"]).toContain("export type Owner = {\n  name: string;\n};");
  });
});
