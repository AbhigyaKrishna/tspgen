import { describe, expect, it } from "vitest";
import { client, TARGET, Tester } from "./tester.js";

const DIR = "client/com/acme/client";

const spec = `
  @service namespace PetStore;
  model Pet { id: int64; name: string }
  @route("/pets") interface Pets {
    @get get(@path petId: int64): Pet;
  }
`;

describe("ktor client json", () => {
  it("declares <Service>Json ignoring unknown keys and uses it as the defaults' format", async () => {
    const api = (await client().compile(spec)).outputs[`${DIR}/PetStoreApiClient.kt`];
    expect(api).toContain(`/**
 * JSON of the PetStore API: the models' serializers and this target's \`features.ignore-unknown-keys\` /
 * \`features.encode-defaults\`. Derive your own with \`Json(PetStoreJson) { … }\` and pass it to \`petStoreDefaults(format)\`.
 */
val PetStoreJson: Json = Json {
    ignoreUnknownKeys = true
}
`);
    expect(api).toContain("fun HttpClientConfig<*>.petStoreDefaults(format: Json = PetStoreJson) {");
  });

  it("follows the ignore-unknown-keys and encode-defaults features", async () => {
    const json = async (features: Record<string, boolean>) =>
      (await client({ features }).compile(spec)).outputs[`${DIR}/PetStoreApiClient.kt`];
    expect(await json({ "ignore-unknown-keys": false })).toContain("val PetStoreJson: Json = Json\n");
    expect(await json({ "encode-defaults": true })).toContain(
      "val PetStoreJson: Json = Json {\n    ignoreUnknownKeys = true\n    encodeDefaults = true\n}\n",
    );
  });

  it("puts the java.time serializers in <Service>Json", async () => {
    const api = (
      await client().compile(`
        @service namespace S;
        model Slot { at: utcDateTime }
        @route("/slots") op list(): Slot[];
      `)
    ).outputs[`${DIR}/SApiClient.kt`];
    expect(api).toContain("val SJson: Json = Json {\n    ignoreUnknownKeys = true\n    serializersModule = modelSerializersModule\n}\n");
    expect(api).toContain("import com.acme.models.modelSerializersModule\n");
  });

  it("follows visibility: internal", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-kotlin", {
      package: "com.acme",
      visibility: "internal",
      targets: [{ [TARGET]: {} }],
    }).compile(spec);
    expect(outputs[`${DIR}/PetStoreApiClient.kt`]).toContain("\ninternal val PetStoreJson: Json = Json {");
  });
});

describe("ktor client apiJson", () => {
  it("encodes multipart JSON parts with the Json given to the defaults function", async () => {
    const { outputs } = await client().compile(`
      @service namespace S;
      model Meta { title: string }
      model Form { meta: HttpPart<Meta>; }
      @post op send(@header contentType: "multipart/form-data", @multipartBody body: Form): void;
    `);
    expect(outputs[`${DIR}/SClient.kt`]).toContain('append("meta", http.encodeJson(body.meta), jsonPartHeaders())');
    const support = outputs[`${DIR}/ClientSupport.kt`];
    expect(support).toContain(
      "internal inline fun <reified T> HttpClient.encodeJson(value: T): String = apiJson.encodeToJsonElement(value).toString()\n",
    );
    expect(support).toContain(`internal fun apiJsonPlugin(format: Json): ClientPlugin<Unit> =
    createClientPlugin("TspgenJson") { client.attributes.put(apiJsonKey, format) }`);
    expect(support).toContain(`internal val HttpClient.apiJson: Json
    get() = attributes.getOrNull(apiJsonKey) ?: SJson`);
    expect(support).not.toContain("partJson");
    expect(outputs[`${DIR}/SApiClient.kt`]).toContain("    install(apiJsonPlugin(format))\n");
  });
});

describe("ktor client error handling", () => {
  it("disables expectSuccess per request and reads a problem's detail as the ApiException message", async () => {
    const { outputs } = await client().compile(spec);
    const pets = outputs[`${DIR}/PetsClient.kt`];
    expect(pets).toContain("        val response = http.request {\n            expectSuccess = false\n            method = HttpMethod.Get\n");
    expect(pets).toContain("import io.ktor.client.plugins.expectSuccess\n");
    expect(pets).toContain("            else -> ApiException(response.status.value, response.errorMessage())\n");
    expect(pets).not.toContain("bodyAsText");
    // No typed error body: nothing to guard.
    expect(pets).not.toContain("isProblem");
    const support = outputs[`${DIR}/ClientSupport.kt`];
    expect(support).toContain(
      "internal fun HttpResponse.isProblem(): Boolean = contentType()?.match(ContentType.Application.ProblemJson) == true\n",
    );
    expect(support).toContain(`internal suspend fun HttpResponse.errorMessage(): String {
    val text = bodyAsText()
    if (!isProblem()) return text
    return runCatching { Json.parseToJsonElement(text).jsonObject["detail"]?.jsonPrimitive?.contentOrNull }.getOrNull() ?: text
}`);
  });

  it("raises ApiException for a problem+json response instead of decoding it as a declared error model", async () => {
    const { outputs } = await client().compile(`
      @service namespace PetStore;
      model Pet { id: int64 }
      @error model BadInput { @statusCode _: 400; code: string }
      @route("/pets") interface Pets {
        @get get(@path petId: int64): Pet | BadInput;
      }
    `);
    const pets = outputs[`${DIR}/PetsClient.kt`];
    expect(pets).toContain(`        if (response.isProblem()) throw ApiException(response.status.value, response.errorMessage())
        throw when (response.status.value) {
            400 -> BadInputException(response.body(), response.status.value)
`);
  });
});
