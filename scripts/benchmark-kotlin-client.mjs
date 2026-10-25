import { client } from "../packages/kotlin-ktor-client/test/tester.ts";

const resources = Number(process.argv[2] ?? 100);
if (!Number.isInteger(resources) || resources < 1 || resources > 1000) {
  throw new Error("Resource count must be an integer between 1 and 1000");
}

const declarations = Array.from(
  { length: resources },
  (_, index) => `
  model Item${index} { id: string; next?: Item${index}; }
  model Get${index} { id: string; }
  @route("/items/${index}") interface Items${index} {
    @get get(@query id: string): Item${index};
    @post put(@body body: Item${index}): Item${index};
  }
`,
).join("\n");
const variants = Array.from({ length: resources }, (_, index) => `get${index}: { type: "Get${index}"; params: Get${index}; }`).join(",\n");
const spec = `@service @useAuth(BearerAuth) namespace Benchmark;
${declarations}
@discriminated(#{envelope: "none"}) union Request { ${variants} }
`;

const started = performance.now();
const { outputs } = await client().compile(spec);
const kotlin = Object.entries(outputs).filter(([name]) => name.endsWith(".kt"));
console.log(
  JSON.stringify(
    {
      resources,
      operations: resources * 2,
      files: kotlin.length,
      sourceBytes: kotlin.reduce((sum, [, content]) => sum + Buffer.byteLength(content), 0),
      generationMs: Math.round(performance.now() - started),
    },
    null,
    2,
  ),
);
