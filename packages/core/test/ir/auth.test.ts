import { describe, expect, it } from "vitest";
import { buildApiIR, type OperationIR } from "../../src/index.js";
import { Tester } from "../tester.js";

async function ops(code: string): Promise<Record<string, OperationIR>> {
  const { program } = await Tester.compile(code);
  const [service] = buildApiIR(program).services;
  return Object.fromEntries(service.groups.flatMap((g) => g.operations).map((op) => [op.name, op]));
}

describe("operation auth", () => {
  it("is absent without @useAuth", async () => {
    const { program } = await Tester.compile(`@service namespace S; @route("/a") op a(): void;`);
    const [service] = buildApiIR(program).services;
    expect(service.auth).toEqual([]);
    expect("auth" in service.groups[0].operations[0]).toBe(false);
  });

  it("resolves the nearest @useAuth: operation, then interface, then namespaces", async () => {
    const byName = await ops(`
      @service @useAuth(BearerAuth) namespace S;
      model Key is ApiKeyAuth<ApiKeyLocation.header, "X-Key">;
      @route("/a") op inherited(): void;
      @route("/b") @useAuth(NoAuth) op open(): void;
      @useAuth(Key) @route("/i") interface I {
        @route("/c") @get fromInterface(): void;
        @route("/d") @get @useAuth(BasicAuth) own(): void;
      }
      namespace Inner {
        @route("/e") op nested(): void;
      }
    `);
    expect(byName.inherited.auth).toEqual({ options: [["BearerAuth"]] });
    expect(byName.open.auth).toEqual({ options: [[]] });
    expect(byName.fromInterface.auth).toEqual({ options: [["Key"]] });
    expect(byName.own.auth).toEqual({ options: [["BasicAuth"]] });
    expect(byName.nested.auth).toEqual({ options: [["BearerAuth"]] });
  });

  it("keeps alternatives (|), combinations (&) and NoAuth as an empty option", async () => {
    const byName = await ops(`
      @service namespace S;
      model Key is ApiKeyAuth<ApiKeyLocation.query, "key">;
      @route("/a") @useAuth(BearerAuth | Key) op either(): void;
      @route("/b") @useAuth([BearerAuth, Key]) op both(): void;
      @route("/c") @useAuth(BearerAuth | NoAuth) op optional(): void;
      @route("/d") @useAuth([BearerAuth, Key] | BasicAuth) op mixed(): void;
    `);
    expect(byName.either.auth).toEqual({ options: [["BearerAuth"], ["Key"]] });
    expect(byName.both.auth).toEqual({ options: [["BearerAuth", "Key"]] });
    expect(byName.optional.auth).toEqual({ options: [["BearerAuth"], []] });
    expect(byName.mixed.auth).toEqual({ options: [["BearerAuth", "Key"], ["BasicAuth"]] });
  });

  it("lists every scheme of the service and its operations once in ServiceIR.auth", async () => {
    const { program } = await Tester.compile(`
      @service @useAuth(BearerAuth) namespace S;
      model Key is ApiKeyAuth<ApiKeyLocation.cookie, "sid">;
      @route("/a") @useAuth(Key | BearerAuth) op a(): void;
      @route("/b") @useAuth(BasicAuth | NoAuth) op b(): void;
    `);
    const [service] = buildApiIR(program).services;
    expect(service.auth).toEqual([
      { id: "BearerAuth", type: "http", scheme: "Bearer" },
      { id: "Key", type: "apiKey", in: "cookie", name: "sid" },
      { id: "BasicAuth", type: "http", scheme: "Basic" },
      { id: "NoAuth", type: "noAuth" },
    ]);
  });

  it("renames a different scheme reusing an id, like TypeSpec's OpenAPI output", async () => {
    const byName = await ops(`
      @service namespace S;
      @route("/a") @useAuth(ApiKeyAuth<ApiKeyLocation.header, "X-A">) op a(): void;
      @route("/b") @useAuth(ApiKeyAuth<ApiKeyLocation.query, "b">) op b(): void;
      @route("/c") @useAuth(ApiKeyAuth<ApiKeyLocation.header, "X-A">) op c(): void;
    `);
    expect(byName.a.auth).toEqual({ options: [["ApiKeyAuth"]] });
    expect(byName.b.auth).toEqual({ options: [["ApiKeyAuth_"]] });
    expect(byName.c.auth).toEqual({ options: [["ApiKeyAuth"]] });
    const { program } = await Tester.compile(`
      @service namespace S;
      @route("/a") @useAuth(ApiKeyAuth<ApiKeyLocation.header, "X-A">) op a(): void;
      @route("/b") @useAuth(ApiKeyAuth<ApiKeyLocation.query, "b">) op b(): void;
    `);
    expect(buildApiIR(program).services[0].auth).toEqual([
      { id: "ApiKeyAuth", type: "apiKey", in: "header", name: "X-A" },
      { id: "ApiKeyAuth_", type: "apiKey", in: "query", name: "b" },
    ]);
  });

  it("does not rename the schemes TypeSpec state holds (no mutation across builds)", async () => {
    const code = `
      @service namespace S;
      @route("/a") @useAuth(ApiKeyAuth<ApiKeyLocation.header, "X-A">) op a(): void;
      @route("/b") @useAuth(ApiKeyAuth<ApiKeyLocation.query, "b">) op b(): void;
    `;
    const { program } = await Tester.compile(code);
    const first = buildApiIR(program).services[0].auth.map((a) => a.id);
    const second = buildApiIR(program).services[0].auth.map((a) => a.id);
    expect(second).toEqual(first);
  });

  it("resolves auth for operations of an interface extending another, and for op-is templates", async () => {
    const { program } = await Tester.compile(`
      @service @useAuth(BearerAuth) namespace S;
      interface Base { @get @route("/base") b(): void; }
      @route("/derived") @useAuth(BasicAuth) interface Derived extends Base { @get @route("/own") own(): void; }
      @get @useAuth(NoAuth) op publicTemplate<T>(): void;
      @get op plainTemplate<T>(): void;
      @route("/t") interface T2 {
        @route("/a") a is publicTemplate<string>;
        @route("/b") b is plainTemplate<string>;
        @route("/c") @useAuth(BasicAuth) c is publicTemplate<string>;
      }
    `);
    const [service] = buildApiIR(program).services;
    const byId = Object.fromEntries(service.groups.flatMap((g) => g.operations).map((op) => [op.id, op.auth]));
    // Operations copied into Derived take Derived's @useAuth; Base's own route keeps the service's.
    expect(byId["S.Derived.b"]).toEqual({ options: [["BasicAuth"]] });
    expect(byId["S.Derived.own"]).toEqual({ options: [["BasicAuth"]] });
    expect(byId["S.Base.b"]).toEqual({ options: [["BearerAuth"]] });
    // `op is` carries the template's @useAuth; one on the instance wins.
    expect(byId["S.T2.a"]).toEqual({ options: [[]] });
    expect(byId["S.T2.b"]).toEqual({ options: [["BearerAuth"]] });
    expect(byId["S.T2.c"]).toEqual({ options: [["BasicAuth"]] });
  });

  it("keys oauth2 and openIdConnect schemes without their scopes, so scoped uses share one id", async () => {
    const { program } = await Tester.compile(`
      @service namespace S;
      model Flow { type: OAuth2FlowType.clientCredentials; tokenUrl: "https://example.com/token"; }
      model OtherFlow { type: OAuth2FlowType.clientCredentials; tokenUrl: "https://other.example.com/token"; }
      @route("/a") @useAuth(OAuth2Auth<[Flow], ["read"]>) op a(): void;
      @route("/b") @useAuth(OAuth2Auth<[Flow], ["write"]>) op b(): void;
      @route("/c") @useAuth(OAuth2Auth<[OtherFlow]>) op c(): void;
      @route("/d") @useAuth(OpenIdConnectAuth<"https://example.com/.well-known/openid-configuration">) op d(): void;
      @route("/e") @useAuth(OpenIdConnectAuth<"https://example.com/.well-known/openid-configuration">) op e(): void;
      @route("/f") @useAuth(OpenIdConnectAuth<"https://other.example.com/.well-known/openid-configuration">) op f(): void;
    `);
    const [service] = buildApiIR(program).services;
    const byName = Object.fromEntries(service.groups.flatMap((g) => g.operations).map((op) => [op.name, op.auth?.options]));
    expect(byName).toEqual({
      a: [["OAuth2Auth"]],
      b: [["OAuth2Auth"]],
      c: [["OAuth2Auth_"]],
      d: [["OpenIdConnectAuth"]],
      e: [["OpenIdConnectAuth"]],
      f: [["OpenIdConnectAuth_"]],
    });
    expect(service.auth.map((a) => [a.id, a.type])).toEqual([
      ["OAuth2Auth", "oauth2"],
      ["OAuth2Auth_", "oauth2"],
      ["OpenIdConnectAuth", "openIdConnect"],
      ["OpenIdConnectAuth_", "openIdConnect"],
    ]);
  });
});
