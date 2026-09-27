import { describe, expect, it } from "vitest";
import { server, sseServer } from "./tester.js";

const DIR = "server/com/acme/server";

describe("ktor server type mapping", () => {
  it("parses and writes ULong parameters and headers", async () => {
    const { outputs } = await server().compile(`
      @service namespace S;
      @route("/counters/{id}") op get(@path id: uint64, @query ids?: uint64[]): { @header total: uint64 };
    `);
    const routes = outputs[`${DIR}/SRoutes.kt`];
    expect(routes).toContain(`val id = call.pathParam("id").convertParam("id") { it.toULong() }`);
    expect(routes).toContain(`val ids = call.queryParam("ids")?.split(",")?.map { it.convertParam("ids") { it.toULong() } }`);
    expect(routes).toContain(`call.response.header("total", result.total.toString())`);
  });

  it("parses and writes BigDecimal parameters", async () => {
    const { outputs } = await server().compile(`
      @service namespace S;
      @route("/prices") op list(@query min?: decimal): { @header total: decimal };
    `);
    const routes = outputs[`${DIR}/SRoutes.kt`];
    expect(routes).toContain(`val min = call.queryParam("min")?.convertParam("min") { it.toBigDecimal() }`);
    expect(routes).toContain(`call.response.header("total", result.total.toPlainString())`);
  });

  it("converts value-class and typealias parameters through their base type", async () => {
    const scalarSpec = `
      @service namespace S;
      scalar PetId extends string;
      @route("/pets/{id}") op get(@path id: PetId, @query ids?: PetId[]): void;
    `;
    const wrapped = await server({}, { "scalar-style": "value-class" }).compile(scalarSpec);
    const routes = wrapped.outputs[`${DIR}/SRoutes.kt`];
    expect(routes).toContain(`val id = call.pathParam("id").convertParam("id") { PetId(it) }`);
    expect(routes).toContain(`val ids = call.queryParam("ids")?.split(",")?.map { it.convertParam("ids") { PetId(it) } }`);
    const aliased = await server({}, { "scalar-style": "typealias" }).compile(scalarSpec);
    expect(aliased.outputs[`${DIR}/SRoutes.kt`]).toContain(`val id = call.pathParam("id")\n`);
  });

  it("imports the underlying java.time type a value-class/typealias scalar param decodes through", async () => {
    const spec = `
      @service namespace S;
      scalar Seen extends utcDateTime;
      @route("/events") op list(@query seen?: Seen, @query seens?: Seen[]): void;
    `;
    const wrapped = await server({}, { "scalar-style": "value-class" }).compile(spec);
    const wrappedRoutes = wrapped.outputs[`${DIR}/SRoutes.kt`];
    expect(wrappedRoutes).toContain("import java.time.Instant\n");
    expect(wrappedRoutes).toContain(`val seen = call.queryParam("seen")?.convertParam("seen") { Seen(Instant.parse(it)) }`);
    expect(wrappedRoutes).toContain(`val seens = call.queryParam("seens")?.split(",")?.map { it.convertParam("seens") { Seen(Instant.parse(it)) } }`);
    const aliased = await server({}, { "scalar-style": "typealias" }).compile(spec);
    const aliasedRoutes = aliased.outputs[`${DIR}/SRoutes.kt`];
    expect(aliasedRoutes).toContain("import java.time.Instant\n");
    expect(aliasedRoutes).toContain(`val seen = call.queryParam("seen")?.convertParam("seen") { Instant.parse(it) }`);
  });

  it("imports the underlying BigDecimal type a value-class/typealias decimal-rooted scalar param decodes through", async () => {
    const spec = `
      @service namespace S;
      scalar Money extends decimal;
      @route("/prices") op list(@query price?: Money): void;
    `;
    const wrapped = await server({}, { "scalar-style": "value-class" }).compile(spec);
    const wrappedRoutes = wrapped.outputs[`${DIR}/SRoutes.kt`];
    expect(wrappedRoutes).toContain("import java.math.BigDecimal\n");
    expect(wrappedRoutes).toContain(`val price = call.queryParam("price")?.convertParam("price") { Money(it.toBigDecimal()) }`);
    const aliased = await server({}, { "scalar-style": "typealias" }).compile(spec);
    const aliasedRoutes = aliased.outputs[`${DIR}/SRoutes.kt`];
    expect(aliasedRoutes).toContain("import java.math.BigDecimal\n");
    expect(aliasedRoutes).toContain(`val price = call.queryParam("price")?.convertParam("price") { it.toBigDecimal() }`);
  });

  it("routing-style: resources — a BigDecimal/java.time query or path param needs @file:UseSerializers", async () => {
    const { outputs } = await server({ "routing-style": "resources" }).compile(`
      @service namespace S;
      @route("/prices/{id}") op get(@path id: decimal, @query at?: utcDateTime): void;
    `);
    const routes = outputs[`${DIR}/SRoutes.kt`];
    expect(routes).toContain("@file:UseSerializers(BigDecimalSerializer::class, InstantSerializer::class)");
    expect(routes).toContain("import com.acme.models.BigDecimalSerializer\n");
    expect(routes).toContain("import com.acme.models.InstantSerializer\n");
    expect(routes).toContain("import kotlinx.serialization.UseSerializers\n");
    expect(routes).toContain("class GetResource(val id: BigDecimal, val at: Instant? = null)");
  });

  it("routing-style: resources — no @file:UseSerializers without a BigDecimal/java.time resource param", async () => {
    const { outputs } = await server({ "routing-style": "resources" }).compile(`
      @service namespace S;
      @route("/pets/{id}") op get(@path id: string): void;
    `);
    expect(outputs[`${DIR}/SRoutes.kt`]).not.toContain("UseSerializers");
  });

  describe("@encode(string) on top-level JSON values", () => {
    const spec = `
      @service namespace S;
      @encode(string) scalar BigId extends int64;
      @error model Missing { @statusCode _: 404; ids: BigId[] }
      @route("/ids") interface Ids {
        @get list(): BigId[];
        @get @route("/one") one(): BigId;
        @post take(@body ids: BigId[]): void;
        @put @route("/maybe") maybe(@header contentType: "application/json", @body id?: BigId): void;
        @put @route("/text") text(@body id: BigId): void;
        @post @route("/raw") raw(@header contentType: "application/json", @body @encode(string) raw: int64): void;
        @get @route("/either") either(): { @statusCode _: 200; @body ids: BigId[] } | { @statusCode _: 201; @header location: string } | Missing;
        @get @route("/plain") plain(): int64[];
      }
    `;

    for (const style of ["inline", "typealias"] as const) {
      it(`${style}: receives and responds through the explicit serializer`, async () => {
        const { outputs } = await server({}, { "scalar-style": style }).compile(spec);
        const routes = outputs[`${DIR}/IdsRoutes.kt`];
        expect(routes).toContain("call.respondJson(HttpStatusCode.OK, ListSerializer(LongAsStringSerializer), service.list())");
        expect(routes).toContain("call.respondJson(HttpStatusCode.OK, LongAsStringSerializer, service.one())");
        expect(routes).toContain("val ids = call.receiveJson(ListSerializer(LongAsStringSerializer))");
        expect(routes).toContain("val id = call.receiveJson(LongAsStringSerializer.nullable)");
        expect(routes).toContain("val raw = call.receiveJson(LongAsStringSerializer)");
        expect(routes).toContain("call.respondJson(HttpStatusCode.OK, ListSerializer(LongAsStringSerializer), result.body)");
        // A text/plain scalar body is no JSON: unchanged.
        expect(routes).toContain(`val id = call.receive<${style === "inline" ? "Long" : "BigId"}>()`);
        // Values without an @encode(string) inside keep Ktor's content negotiation.
        expect(routes).toContain("call.respond(HttpStatusCode.OK, service.plain())");
        expect(routes).toContain("import kotlinx.serialization.builtins.ListSerializer\n");
        expect(routes).toContain("import kotlinx.serialization.builtins.LongAsStringSerializer\n");
        expect(routes).toContain("import kotlinx.serialization.builtins.nullable\n");
        const support = outputs[`${DIR}/ServerSupport.kt`];
        expect(support).toContain("internal suspend fun <T> ApplicationCall.receiveJson(serializer: KSerializer<T>): T {");
        expect(support).toContain(
          "internal suspend fun <T> ApplicationCall.respondJson(status: HttpStatusCode, serializer: KSerializer<T>, value: T) =\n" +
            "    respondText(serverJson.encodeToString(serializer, value), ContentType.Application.Json, status)",
        );
      });
    }

    it("writes a typed error body through its serializer", async () => {
      const { outputs } = await server().compile(`
        @service namespace S;
        @encode(string) scalar BigId extends int64;
        @error model Missing { @statusCode _: 404; @body id: BigId }
        @route("/ids") op list(): BigId[] | Missing;
      `);
      const errors = outputs[`${DIR}/SErrors.kt`];
      expect(errors).toContain("call.respondJson(HttpStatusCode.fromValue(cause.status), LongAsStringSerializer, cause.error)");
      expect(errors).toContain("import kotlinx.serialization.builtins.LongAsStringSerializer\n");
      expect(errors).not.toContain("import io.ktor.server.response.respond\n");
    });

    it("leaves ordinary output alone: no JSON helpers without a serializer to apply", async () => {
      const { outputs } = await server().compile(`
        @service namespace S;
        model Pet { id: int64 }
        @route("/pets") op list(): Pet[];
      `);
      expect(outputs[`${DIR}/ServerSupport.kt`]).not.toContain("receiveJson");
      expect(outputs[`${DIR}/ServerSupport.kt`]).not.toContain("respondJson");
      expect(outputs[`${DIR}/SRoutes.kt`]).toContain("call.respond(HttpStatusCode.OK, service.list())");
    });

    it("imports the JSON helpers into routes of mapped packages", async () => {
      const { outputs } = await server({}, { packages: [{ namespace: "S.Ids", package: "com.acme.ids" }] }).compile(`
        @service namespace S;
        @encode(string) scalar BigId extends int64;
        namespace Ids {
          @route("/ids") op list(@body ids: BigId[]): BigId[];
        }
      `);
      const routes = outputs["server/com/acme/ids/IdsRoutes.kt"];
      expect(routes).toContain("import com.acme.server.receiveJson\n");
      expect(routes).toContain("import com.acme.server.respondJson\n");
    });

    it("encodes JSON event payloads and decodes JSON parts with the serializer", async () => {
      const events = await sseServer().compile(`
        @service namespace S;
        @encode(string) scalar BigId extends int64;
        @events union Feed { ids: BigId[] }
        @route("/feed") op watch(): SSEStream<Feed>;
      `);
      const support = events.outputs[`${DIR}/ServerSupport.kt`];
      expect(support).toContain("serverJson.encodeToJsonElement(ListSerializer(LongAsStringSerializer), data).toString()");
      expect(support).toContain("import kotlinx.serialization.builtins.ListSerializer\n");
      const parts = await server().compile(`
        @service namespace S;
        @encode(string) scalar BigId extends int64;
        model Form { ids: HttpPart<BigId[]>; name: HttpPart<string> }
        @route("/form") op send(@header contentType: "multipart/form-data", @multipartBody body: Form): void;
      `);
      const routes = parts.outputs[`${DIR}/SRoutes.kt`];
      expect(routes).toContain('convertParam("ids") { serverJson.decodeFromString(ListSerializer(LongAsStringSerializer), it) }');
      expect(routes).toContain("import kotlinx.serialization.builtins.ListSerializer\n");
    });
  });
});
