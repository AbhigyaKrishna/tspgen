import { describe, expect, it } from "vitest";
import { meetingSpec, nextjs, petSpec } from "./tester.js";
import { typecheck } from "./typecheck.js";

const dates = { features: { zod: true }, "date-type": "date" };

describe("grouped client with date-type: date", () => {
  it("decodes responses, encodes Date parameters and checks Server Action input by encoding", async () => {
    const { outputs } = await nextjs({}, dates).compile(meetingSpec);
    const core = outputs["client/core.ts"];
    expect(core).toContain("type Scalar = string | number | boolean | Date | null | undefined;");
    expect(core).toContain(`/** A parameter value as sent: dates as ISO-8601 strings. */
function toText(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}`);
    expect(core).toContain("return Array.isArray(value) ? value.map(toText).join(\",\") : toText(value);");
    expect(core).toContain(`export async function parse<T>(config: ClientConfig, res: Response, schema?: Schema<T>, codec = false): Promise<T> {
  const body = await readBody(res);
  return schema && (codec || config.validate !== false) ? schema.parse(body) : (body as T);
}`);
    const meetings = outputs["client/meetings.ts"];
    expect(meetings).toContain("if (res.ok) return parse(this.config, res, z.array(z.lazy(() => MeetingSchema)), true);");
    expect(meetings).toContain("path: `/meetings/${encodeURIComponent(params.day.toISOString())}`,");
    expect(meetings).toContain(
      "return { status: 200, body: await parse(this.config, res, z.array(z.lazy(() => MeetingSchema)), true), headers: { modified: new Date(requireHeader(res, \"last-modified\")) } };",
    );
    expect(meetings).toContain(
      "409: (status, body) => { const r = z.lazy(() => ProblemSchema).safeParse(body); return new ProblemError(status, r.success ? r.data : (body as Problem)); },",
    );
    expect(meetings).toContain('import { ProblemSchema } from "../models/Problem";');
    expect(outputs["client/actions/meetings.ts"]).toContain(`  const checked = MeetingsCreateParamsSchema.safeEncode(withoutUndefined(params) as MeetingsCreateParams);
  if (!checked.success) return { ok: false, status: 400, error: { issues: checked.error.issues } };
  return runAction(() => shopServerClient().meetings.create(MeetingsCreateParamsSchema.parse(checked.data)));`);
    // Server Actions reference process.env (see client/actions/server-client.ts); the typecheck harness excludes
    // @types/node (`types: []`), so the same env.d.ts shim client.test.ts uses is needed here.
    const env = { "env.d.ts": "declare const process: { env: Record<string, string | undefined> };\n" };
    expect(typecheck({ ...outputs, ...env })).toBe("");
  });

  it("sends Date multipart text parts as ISO strings", async () => {
    const { outputs } = await nextjs({}, dates).compile(`
      @service namespace Shop;
      model Form { at: HttpPart<utcDateTime> }
      @route("/forms") op send(@header contentType: "multipart/form-data", @multipartBody body: Form): void;
    `);
    expect(outputs["client/core.ts"]).toContain("form.append(part.name, toText(item));");
  });

  it("a model literally named Date compiles in both layouts (grouped client)", async () => {
    const spec = `
      @service namespace Shop;
      model Date { x: int32 }
      model M { at: utcDateTime; d: Date }
      @route("/m") interface Ms { @get get(@query at: utcDateTime): M; }
    `;
    for (const layout of ["per-type", "single-file"] as const) {
      const { outputs } = await nextjs({ features: { "react-query": false, "server-actions": false } }, { ...dates, layout }).compile(spec);
      expect(typecheck(outputs)).toBe("");
    }
  });

  it("keeps the runtime byte-identical without date-type: date", async () => {
    const { outputs } = await nextjs({}, { features: { zod: true } }).compile(petSpec);
    const core = outputs["client/core.ts"];
    expect(core).toContain("type Scalar = string | number | boolean | null | undefined;");
    expect(core).not.toContain("toText");
    expect(core).toContain("export async function parse<T>(config: ClientConfig, res: Response, schema?: Schema<T>): Promise<T> {");
  });
});
