import { describe, expect, it } from "vitest";
import { client } from "./tester.js";

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
});
