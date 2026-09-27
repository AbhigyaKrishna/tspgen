import { describe, expect, it } from "vitest";
import { server } from "./tester.js";

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
});
