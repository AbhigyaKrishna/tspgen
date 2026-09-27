import { describe, expect, it } from "vitest";
import { client, sseClient } from "./tester.js";

const DIR = "client/com/acme/client";

describe("ktor client type mapping", () => {
  it("writes and parses ULong parameters and headers", async () => {
    const { outputs } = await client().compile(`
      @service namespace S;
      @route("/counters/{id}") op get(@path id: uint64, @query ids?: uint64[]): { @header total: uint64 };
    `);
    const code = outputs[`${DIR}/SClient.kt`];
    expect(code).toContain(`appendPathSegments("counters", id.toString())`);
    expect(code).toContain(`ids?.let { values -> parameters.append("ids", values.joinToString(",") { it.toString() }) }`);
    expect(code).toContain(`response.headers["total"] ?: throw ApiException(response.status.value, "missing header total")).toULong()`);
  });

  it("writes and parses BigDecimal parameters", async () => {
    const { outputs } = await client().compile(`
      @service namespace S;
      @route("/prices") op list(@query min?: decimal): { @header total: decimal };
    `);
    const code = outputs[`${DIR}/SClient.kt`];
    expect(code).toContain(`min?.let { parameters.append("min", it.toPlainString()) }`);
    expect(code).toContain(`"missing header total")).toBigDecimal()`);
  });

  it("writes value-class parameters through their value", async () => {
    const { outputs } = await client({}, { "scalar-style": "value-class" }).compile(`
      @service namespace S;
      scalar PetId extends string;
      @route("/pets/{id}") op get(@path id: PetId, @query ids?: PetId[]): void;
    `);
    const code = outputs[`${DIR}/SClient.kt`];
    expect(code).toContain(`appendPathSegments("pets", id.value)`);
    expect(code).toContain(`ids?.let { values -> parameters.append("ids", values.joinToString(",") { it.value }) }`);
  });

  it("imports the underlying java.time type a value-class/typealias scalar query param and response header decode through", async () => {
    const spec = `
      @service namespace S;
      scalar Seen extends utcDateTime;
      @route("/events") op list(@query seen?: Seen): { @header at: Seen };
    `;
    const wrapped = await client({}, { "scalar-style": "value-class" }).compile(spec);
    const wrappedCode = wrapped.outputs[`${DIR}/SClient.kt`];
    expect(wrappedCode).toContain("import java.time.Instant\n");
    expect(wrappedCode).toContain(
      `Seen(Instant.parse((response.headers["at"] ?: throw ApiException(response.status.value, "missing header at"))))`,
    );
    const aliased = await client({}, { "scalar-style": "typealias" }).compile(spec);
    const aliasedCode = aliased.outputs[`${DIR}/SClient.kt`];
    expect(aliasedCode).toContain("import java.time.Instant\n");
    expect(aliasedCode).toContain(
      `Instant.parse((response.headers["at"] ?: throw ApiException(response.status.value, "missing header at")))`,
    );
  });

  it("imports the underlying BigDecimal type a value-class/typealias decimal-rooted scalar response header decodes through", async () => {
    const spec = `
      @service namespace S;
      scalar Money extends decimal;
      @route("/prices") op list(@query price?: Money): { @header total: Money };
    `;
    const wrapped = await client({}, { "scalar-style": "value-class" }).compile(spec);
    const wrappedCode = wrapped.outputs[`${DIR}/SClient.kt`];
    expect(wrappedCode).toContain("import java.math.BigDecimal\n");
    expect(wrappedCode).toContain(`price?.let { parameters.append("price", it.value.toPlainString()) }`);
    expect(wrappedCode).toContain(
      `Money((response.headers["total"] ?: throw ApiException(response.status.value, "missing header total")).toBigDecimal())`,
    );
    const aliased = await client({}, { "scalar-style": "typealias" }).compile(spec);
    const aliasedCode = aliased.outputs[`${DIR}/SClient.kt`];
    expect(aliasedCode).toContain("import java.math.BigDecimal\n");
    expect(aliasedCode).toContain(
      `(response.headers["total"] ?: throw ApiException(response.status.value, "missing header total")).toBigDecimal()`,
    );
  });

  describe("@encode(string) on top-level JSON values", () => {
    const spec = `
      @service namespace S;
      @encode(string) scalar BigId extends int64;
      @error model Missing { @statusCode _: 404; @body id: BigId }
      @route("/ids") interface Ids {
        @get list(): BigId[] | Missing;
        @post take(@body ids: BigId[]): void;
        @put @route("/maybe") maybe(@header contentType: "application/json", @body id?: BigId): void;
        @put @route("/text") text(@body id: BigId): void;
        @get @route("/either") either(): { @statusCode _: 200; @body ids: BigId[] } | { @statusCode _: 201; @header location: string };
        @get @route("/plain") plain(): int64[];
      }
    `;

    for (const style of ["inline", "typealias"] as const) {
      it(`${style}: writes and reads bodies through the explicit serializer and the API client's Json`, async () => {
        const { outputs } = await client({}, { "scalar-style": style }).compile(spec);
        const code = outputs[`${DIR}/IdsClient.kt`];
        expect(code).toContain("return http.apiJson.decodeFromString(ListSerializer(LongAsStringSerializer), response.bodyAsText())");
        expect(code).toContain(
          'setBody(TextContent(http.apiJson.encodeToString(ListSerializer(LongAsStringSerializer), ids), ContentType.parse("application/json")))',
        );
        expect(code).toContain(
          'setBody(TextContent(http.apiJson.encodeToString(LongAsStringSerializer.nullable, id), ContentType.parse("application/json")))',
        );
        expect(code).toContain("200 -> return EitherResult.Ok(http.apiJson.decodeFromString(ListSerializer(LongAsStringSerializer), response.bodyAsText()))");
        const exception = style === "inline" ? "LongException" : "BigIdException";
        expect(code).toContain(`404 -> ${exception}(http.apiJson.decodeFromString(LongAsStringSerializer, response.bodyAsText()), response.status.value)`);
        // A text/plain scalar body is no JSON: unchanged.
        expect(code).toContain('contentType(ContentType.parse("text/plain"))');
        // Values without an @encode(string) inside keep content negotiation.
        expect(code).toContain("return response.body()");
        expect(code).toContain("import io.ktor.http.content.TextContent\n");
        expect(code).toContain("import io.ktor.client.statement.bodyAsText\n");
        expect(code).toContain("import kotlinx.serialization.builtins.ListSerializer\n");
        expect(code).toContain("import kotlinx.serialization.builtins.nullable\n");
        expect(outputs[`${DIR}/ClientSupport.kt`]).toContain("internal val HttpClient.apiJson: Json");
        expect(outputs[`${DIR}/SApiClient.kt`]).toContain("install(apiJsonPlugin(format))");
      });
    }

    it("leaves ordinary output alone: no apiJson without a serializer to apply", async () => {
      const { outputs } = await client().compile(`
        @service namespace S;
        model Pet { id: int64 }
        @route("/pets") op list(@body pets: Pet[]): Pet[];
      `);
      expect(outputs[`${DIR}/ClientSupport.kt`]).not.toContain("apiJson");
      expect(outputs[`${DIR}/SClient.kt`]).toContain("setBody(pets)");
    });

    it("decodes JSON event payloads and encodes JSON parts with the serializer", async () => {
      const events = await sseClient().compile(`
        @service namespace S;
        @encode(string) scalar BigId extends int64;
        @events union Feed { ids: BigId[] }
        @route("/feed") op watch(): SSEStream<Feed>;
      `);
      const support = events.outputs[`${DIR}/ClientSupport.kt`];
      expect(support).toContain("json.decodeFromString(ListSerializer(LongAsStringSerializer), event.data)");
      expect(support).toContain("import kotlinx.serialization.builtins.ListSerializer\n");
      const parts = await client().compile(`
        @service namespace S;
        @encode(string) scalar BigId extends int64;
        model Form { ids: HttpPart<BigId[]>; name: HttpPart<string> }
        @route("/form") op send(@header contentType: "multipart/form-data", @multipartBody body: Form): void;
      `);
      expect(parts.outputs[`${DIR}/SClient.kt`]).toContain(
        'append("ids", http.encodeJson(ListSerializer(LongAsStringSerializer), body.ids), jsonPartHeaders())',
      );
      expect(parts.outputs[`${DIR}/SClient.kt`]).toContain("import kotlinx.serialization.builtins.ListSerializer\n");
      expect(parts.outputs[`${DIR}/ClientSupport.kt`]).toContain(
        "internal fun <T> HttpClient.encodeJson(serializer: KSerializer<T>, value: T): String =\n    apiJson.encodeToJsonElement(serializer, value).toString()",
      );
    });
  });
});
