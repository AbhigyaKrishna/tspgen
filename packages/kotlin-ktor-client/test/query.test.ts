import { expect, it } from "vitest";
import { client } from "./tester.js";

it("preserves nested query brackets while encoding names and all value forms", async () => {
  const { outputs } = await client().compile(`
    @service namespace S;
    @get op search(
      @query("filter[name]") name: string,
      @query("filter[count]") count?: int32,
      @query("ids[]") ids: int32[],
      @query(#{ name: "tags[]", explode: true }) tags?: string[],
      @query("filter&unsafe[x]") special: string,
      @query ordinary?: string,
    ): void;
  `);
  const code = outputs["client/com/acme/client/SClient.kt"];
  expect(code).toContain("import io.ktor.http.encodeURLParameter");
  expect(code).toContain('encodedParameters.append("filter[name]", name.encodeURLParameter())');
  expect(code).toContain('count?.let { encodedParameters.append("filter[count]", it.toString().encodeURLParameter()) }');
  expect(code).toContain('encodedParameters.append("ids[]", ids.joinToString(",") { it.toString() }.encodeURLParameter())');
  expect(code).toContain('tags?.forEach { encodedParameters.append("tags[]", it.encodeURLParameter()) }');
  expect(code).toContain('encodedParameters.append("filter%26unsafe[x]", special.encodeURLParameter())');
  expect(code).toContain('ordinary?.let { parameters.append("ordinary", it) }');
});
