import { expectDiagnostics } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { server } from "./tester.js";

const DIR = "server/com/acme/server";

const spec = `
  @service namespace S;
  model Key is ApiKeyAuth<ApiKeyLocation.header, "X-Key">;
  @route("/secure") interface Secure {
    @get @route("/mixed") @useAuth([BearerAuth, Key] | BasicAuth) mixed(): void;
    @get @route("/optional") @useAuth([BearerAuth, Key] | NoAuth) optional(): void;
  }
`;

describe("Ktor server authentication combinations", () => {
  it("generates exact mixed AND/OR and optional AND requirements without approximation diagnostics", async () => {
    const [{ outputs }, diagnostics] = await server().compileAndDiagnose(spec);
    expectDiagnostics(diagnostics, []);
    const support = outputs[`${DIR}/AuthenticationSupport.kt`];
    expect(support).toContain("internal fun AuthenticationConfig.installAuthCombinations()");
    expect(support).toContain('listOf("BearerAuth", "Key")');
    expect(support).toContain('listOf("BasicAuth")');
    expect(support).toContain("listOf(),");
    expect(support).toContain("val result = AuthenticationContext(context.call)");
    expect(support).toContain("provider.skipWhen.any");
    expect(support).toContain("AuthenticationFailedCause.InvalidCredentials");
    expect(support).toContain("call.respond(UnauthorizedResponse())");
    expect(support).toContain("existing.alternatives == alternatives");
    expect(support).toContain("required by '$name' is not registered");
    const routes = outputs[`${DIR}/SecureRoutes.kt`];
    expect(routes).toContain("installAuthCombinations()");
    expect(routes).not.toContain('authenticate("BearerAuth", "Key", "BasicAuth", strategy = AuthenticationStrategy.Required)');
  });

  it("uses configured Kotlin provider-name expressions in generated combinations", async () => {
    const [{ outputs }, diagnostics] = await server({
      "auth-providers": { BearerAuth: "JWT_AUTH", Key: "PARTNER_PROVIDER" },
    }).compileAndDiagnose(spec);
    expectDiagnostics(diagnostics, []);
    const support = outputs[`${DIR}/AuthenticationSupport.kt`];
    expect(support).toContain("listOf(JWT_AUTH, PARTNER_PROVIDER)");
    expect(support).not.toContain('listOf("JWT_AUTH", "PARTNER_PROVIDER")');
  });
});
