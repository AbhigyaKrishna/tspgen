import { expectDiagnostics } from "@typespec/compiler/testing";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { petSpec, server } from "./tester.js";

const DIR = "server/com/acme/server";
const ROUTES = `${DIR}/SecureRoutes.kt`;

const spec = `
  @service @useAuth(BearerAuth) namespace S;
  model Key is ApiKeyAuth<ApiKeyLocation.header, "X-Key">;
  @route("/secure") interface Secure {
    @get @route("/a") a(): void;
    @get @route("/b") b(): void;
    @get @route("/open") @useAuth(NoAuth) open(): void;
    @get @route("/either") @useAuth(BearerAuth | Key) either(): void;
    @get @route("/both") @useAuth([BearerAuth, Key]) both(): void;
    @get @route("/optional") @useAuth(BearerAuth | NoAuth) optional(): void;
    @get @route("/optional-either") @useAuth(BearerAuth | Key | NoAuth) optionalEither(): void;
  }
`;

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "tspgen-ktor-auth-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

/** A routing style written against ServerOpExtras.authenticate (provider names), as before generated auth. */
const legacyStyle = () =>
  dirWith({
    "templates/legacy/routes.eta": `fun Route.<%= it.unit.routesFn %>(service: <%= it.unit.serviceName %>) {
<% for (const op of it.unit.operations) { const a = it.extras[op.id].authenticate; -%>
    // <%= op.name %>: <%= a.length ? "authenticate(" + a.map((n) => JSON.stringify(n)).join(", ") + ")" : "public" %>
<% } -%>
}`,
    "plugin.mjs": `
      import { fileURLToPath } from "node:url";
      export default {
        name: "legacy-style",
        templates: fileURLToPath(new URL("./templates", import.meta.url)),
        setup(ctx) {
          ctx.registry.register("ktor-server.routing-style", "legacy", {
            template: "legacy/routes",
            imports: () => ["io.ktor.server.routing.Route"],
          });
        },
      };`,
  });

const route = (name: string, indent = "        ") =>
  `${indent}get("/secure/${name}") {\n${indent}    service.${name.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())}()\n${indent}    call.respond(HttpStatusCode.NoContent)\n${indent}}`;

describe("ktor-server generated auth", () => {
  it("wraps each operation per its @useAuth requirement, grouping equal wrappers", async () => {
    const { outputs } = await server().compile(spec);
    const routes = outputs[ROUTES];
    expect(routes).toContain("import io.ktor.server.auth.AuthenticationStrategy\nimport io.ktor.server.auth.authenticate\n");
    expect(routes).toContain(`fun Route.secureRoutes(service: SecureService) {
    authenticate("BearerAuth") {
${route("a")}
${route("b")}
    }
${route("open", "    ")}
    authenticate("BearerAuth", "Key") {
${route("either")}
    }
    authenticate("BearerAuth", "Key", strategy = AuthenticationStrategy.Required) {
${route("both")}
    }
    authenticate("BearerAuth", optional = true) {
${route("optional")}
    }
    authenticate("BearerAuth", "Key", optional = true) {
${route("optional-either")}
    }
}`);
  });

  it("maps scheme ids to provider expressions with auth-providers", async () => {
    const { outputs } = await server({ "auth-providers": { BearerAuth: "JWT_AUTH" } }).compile(spec);
    const routes = outputs[ROUTES];
    expect(routes).toContain(`    authenticate(JWT_AUTH) {\n${route("a")}`);
    expect(routes).toContain(`    authenticate(JWT_AUTH, "Key") {\n${route("either")}`);
  });

  it("rejects empty or blank auth-providers expressions", async () => {
    const [, empty] = await server({ "auth-providers": { BearerAuth: "" } }).compileAndDiagnose(spec);
    expectDiagnostics(empty, { code: "@abhigyakrishna/tspgen-core/invalid-target-options" });
    const [, blank] = await server({ "auth-providers": { BearerAuth: "  " } }).compileAndDiagnose(spec);
    expectDiagnostics(blank, {
      code: "@abhigyakrishna/tspgen-core/invalid-target-options",
      message: /auth-providers\.BearerAuth.*blank/,
    });
  });

  it("warns about auth-providers keys naming no scheme, pointing at renamed ids", async () => {
    const [result, diagnostics] = await server({ "auth-providers": { Bearer: "JWT", Key: "KEY", ApiKeyAuth: "A" } }).compileAndDiagnose(`
      @service @useAuth(BearerAuth) namespace S;
      model Key is ApiKeyAuth<ApiKeyLocation.header, "X-Key">;
      @route("/a") @useAuth(ApiKeyAuth<ApiKeyLocation.header, "X-A"> | ApiKeyAuth<ApiKeyLocation.query, "b"> | Key) op a(): void;
    `);
    expectDiagnostics(diagnostics, {
      code: "@abhigyakrishna/tspgen-core/unknown-auth-provider",
      severity: "warning",
      message: /'Bearer'.*BearerAuth, ApiKeyAuth, ApiKeyAuth_, Key.*_/,
    });
    expect(result.outputs[`${DIR}/SRoutes.kt`]).toContain(`authenticate(A, "ApiKeyAuth_", KEY)`);
  });

  it("quotes scheme ids that are not identifiers as string literals", async () => {
    const { outputs } = await server().compile(`
      @service namespace S;
      @useAuth(ApiKeyAuth<ApiKeyLocation.header, "X-A">) @route("/secure") interface Secure { @get @route("/a") a(): void; }
      model \`$weird key\` is BearerAuth;
      @route("/w") interface W { @get @useAuth(\`$weird key\`) w(): void; }
    `);
    expect(outputs[ROUTES]).toContain(`    authenticate("ApiKeyAuth") {`);
    expect(outputs[`${DIR}/WRoutes.kt`]).toContain(`    authenticate("\\$weird key") {`);
  });

  it("lets the authenticate meta key replace the generated wrapper, before wrap", async () => {
    const { outputs } = await server().compile(`using TspGen;\n${spec}
      @@meta(S.Secure.a, "kotlin:ktor-server", #{ authenticate: "jwt", wrap: #["rateLimit(RL)"] });
      @@meta(S.Secure.b, "kotlin:ktor-server", #{ wrap: #["rateLimit(RL)"] });
    `);
    const routes = outputs[ROUTES];
    expect(routes).toContain(`    authenticate("jwt") {
        rateLimit(RL) {
${route("a", "            ")}
        }
    }
    authenticate("BearerAuth") {
        rateLimit(RL) {
${route("b", "            ")}
        }
    }`);
  });

  it("renders generated wrappers in Resources style, including combined schemes", async () => {
    const { outputs } = await server({ "routing-style": "resources" }).compile(spec);
    const routes = outputs[ROUTES];
    expect(routes).toContain(`    authenticate("BearerAuth", "Key", strategy = AuthenticationStrategy.Required) {
        get<SecureResources.BothResource> { resource ->`);
    expect(routes).toContain(`    authenticate("BearerAuth", optional = true) {
        get<SecureResources.OptionalResource> { resource ->`);
    expect(routes).not.toMatch(/authenticate\([^)]*\) \{\n\s+get<SecureResources.OpenResource>/);
  });

  it("reports alternatives of several schemes each as unsupported and fails closed: every scheme required", async () => {
    const [result, diagnostics] = await server().compileAndDiagnose(`
      @service namespace S;
      model Key is ApiKeyAuth<ApiKeyLocation.header, "X-Key">;
      @route("/secure") interface Secure { @get @route("/m") @useAuth([BearerAuth, Key] | BasicAuth) m(): void; }
    `);
    expectDiagnostics(diagnostics, {
      code: "@abhigyakrishna/tspgen-core/unsupported-auth-combination",
      message: /S\.Secure\.m.*\(BearerAuth & Key\) \| BasicAuth.*every scheme.*@meta\("kotlin:ktor-server", #\{ authenticate: … \}\)\.$/,
    });
    expect(diagnostics[0].message).not.toContain("wrap");
    const target = diagnostics[0].target as { kind?: string; name?: string };
    expect([target.kind, target.name]).toEqual(["Operation", "m"]);
    expect(result.outputs[ROUTES]).toContain(
      `    authenticate("BearerAuth", "Key", "BasicAuth", strategy = AuthenticationStrategy.Required) {\n${route("m")}`,
    );
    expect(result.outputs[ROUTES]).toContain("import io.ktor.server.auth.AuthenticationStrategy\n");
  });

  it("warns that a combination of several schemes or NoAuth is approximated by optional = true", async () => {
    const [result, diagnostics] = await server().compileAndDiagnose(`
      @service namespace S;
      model Key is ApiKeyAuth<ApiKeyLocation.header, "X-Key">;
      @route("/secure") interface Secure {
        @get @route("/a") @useAuth([BearerAuth, Key] | NoAuth) a(): void;
        @get @route("/b") @useAuth([BearerAuth, Key] | BasicAuth | NoAuth) b(): void;
        @get @route("/c") @useAuth(BearerAuth | Key | NoAuth) c(): void;
      }
    `);
    expectDiagnostics(diagnostics, [
      {
        code: "@abhigyakrishna/tspgen-core/auth-combination-approximated",
        severity: "warning",
        message: /S\.Secure\.a.*\(BearerAuth & Key\) \| NoAuth.*optional = true.*first valid credential/,
      },
      { code: "@abhigyakrishna/tspgen-core/auth-combination-approximated", message: /S\.Secure\.b/ },
    ]);
    const target = diagnostics[0].target as { kind?: string; name?: string };
    expect([target.kind, target.name]).toEqual(["Operation", "a"]);
    expect(result.outputs[ROUTES]).toContain(`    authenticate("BearerAuth", "Key", optional = true) {\n${route("a")}`);
    expect(result.outputs[ROUTES]).toContain(`    authenticate("BearerAuth", "Key", "BasicAuth", optional = true) {\n${route("b")}`);
  });

  it("does not warn about an approximated combination the authenticate meta key replaces", async () => {
    const [, diagnostics] = await server().compileAndDiagnose(`using TspGen;
      @service namespace S;
      model Key is ApiKeyAuth<ApiKeyLocation.header, "X-Key">;
      @route("/secure") interface Secure { @get @route("/a") @useAuth([BearerAuth, Key] | NoAuth) a(): void; }
      @@meta(S.Secure.a, "kotlin:ktor-server", #{ authenticate: "custom" });
    `);
    expectDiagnostics(diagnostics, []);
  });

  it("does not report an unsupported combination the authenticate meta key replaces", async () => {
    const [, diagnostics] = await server().compileAndDiagnose(`using TspGen;
      @service namespace S;
      model Key is ApiKeyAuth<ApiKeyLocation.header, "X-Key">;
      @route("/secure") interface Secure { @get @route("/m") @useAuth([BearerAuth, Key] | BasicAuth) m(): void; }
      @@meta(S.Secure.m, "kotlin:ktor-server", #{ authenticate: "custom" });
    `);
    expectDiagnostics(diagnostics, []);
  });

  it("lets an authenticate meta key inherited from the interface or namespace replace an operation's own @useAuth", async () => {
    const { outputs } = await server().compile(`using TspGen;
      @service namespace S;
      model Key is ApiKeyAuth<ApiKeyLocation.header, "X-Key">;
      @route("/secure") interface Secure { @get @route("/a") @useAuth([BearerAuth, Key]) a(): void; }
      namespace Inner { @route("/inner") interface I { @get @useAuth(BearerAuth) i(): void; } }
      @@meta(S.Secure, "kotlin:ktor-server", #{ authenticate: "loose" });
      @@meta(S.Inner, "kotlin:ktor-server", #{ authenticate: "inner" });
    `);
    expect(outputs[ROUTES]).toContain(`    authenticate("loose") {\n${route("a")}`);
    expect(outputs[ROUTES]).not.toContain("AuthenticationStrategy");
    expect(outputs[`${DIR}/IRoutes.kt`]).toContain(`    authenticate("inner") {`);
  });

  it("keeps ServerOpExtras.authenticate the effective provider names, with the details in new fields", async () => {
    const dir = legacyStyle();
    const [result, diagnostics] = await server({ "routing-style": "legacy" }, { plugins: [join(dir, "plugin.mjs")] }).compileAndDiagnose(`using TspGen;\n${spec}
      @@meta(S.Secure.b, "kotlin:ktor-server", #{ authenticate: "jwt" });
    `);
    const routes = result.outputs[ROUTES];
    expect(routes).toContain(`    // a: authenticate("BearerAuth")`);
    expect(routes).toContain(`    // b: authenticate("jwt")`);
    expect(routes).toContain(`    // open: public`);
    expect(routes).toContain(`    // either: authenticate("BearerAuth", "Key")`);
    // Names alone cannot say "both required" or "optional": those operations are warned about.
    expect(routes).toContain(`    // both: authenticate("BearerAuth", "Key")`);
    expectDiagnostics(diagnostics, [
      { code: "@abhigyakrishna/tspgen-core/auth-wrapper-not-rendered", severity: "warning", message: /S\.Secure\.both.*strategy = AuthenticationStrategy\.Required.*routing style 'legacy'.*ServerOpExtras\.auth/ },
      { code: "@abhigyakrishna/tspgen-core/auth-wrapper-not-rendered", message: /S\.Secure\.optional\b.*optional = true/ },
      { code: "@abhigyakrishna/tspgen-core/auth-wrapper-not-rendered", message: /S\.Secure\.optionalEither/ },
    ]);
  });

  it("warns about auth-providers expressions a routing style reading provider names would miss", async () => {
    const dir = legacyStyle();
    const [, diagnostics] = await server(
      { "routing-style": "legacy", "auth-providers": { BearerAuth: "JWT_AUTH" } },
      { plugins: [join(dir, "plugin.mjs")] },
    ).compileAndDiagnose(`
      @service @useAuth(BearerAuth) namespace S;
      @route("/secure") interface Secure { @get @route("/a") a(): void; }
    `);
    expectDiagnostics(diagnostics, [
      { code: "@abhigyakrishna/tspgen-core/auth-wrapper-not-rendered", message: /S\.Secure\.a.*authenticate\(JWT_AUTH\)/ },
    ]);
  });

  it("warns when an overridden routes template may not render strategy or optional", async () => {
    const dir = dirWith({ "ktor-server/routes/dsl-nodes.eta": "// custom\n" });
    const [, diagnostics] = await server({}, { "template-dir": dir }).compileAndDiagnose(`
      @service namespace S;
      model Key is ApiKeyAuth<ApiKeyLocation.header, "X-Key">;
      @route("/secure") interface Secure {
        @get @route("/a") @useAuth(BearerAuth) a(): void;
        @get @route("/both") @useAuth([BearerAuth, Key]) both(): void;
      }
    `);
    expectDiagnostics(diagnostics, [
      { code: "@abhigyakrishna/tspgen-core/auth-wrapper-not-rendered", message: /S\.Secure\.both.*template 'ktor-server\/routes\/dsl-nodes'/ },
    ]);
    // Overriding a template that does not render wrappers is fine.
    const other = dirWith({ "ktor-server/routes/dsl-route.eta": "// custom\n" });
    const [, none] = await server({}, { "template-dir": other }).compileAndDiagnose(`
      @service namespace S;
      model Key is ApiKeyAuth<ApiKeyLocation.header, "X-Key">;
      @route("/secure") interface Secure { @get @route("/both") @useAuth([BearerAuth, Key]) both(): void; }
    `);
    expectDiagnostics(none, []);
  });

  it("generates nothing with features.auth false", async () => {
    const { outputs } = await server({ features: { auth: false } }).compile(spec);
    expect(outputs[ROUTES]).not.toContain("authenticate");
  });

  it("leaves output without @useAuth unchanged: no auth imports or wrappers", async () => {
    const { outputs } = await server().compile(petSpec);
    for (const [path, content] of Object.entries(outputs)) {
      if (path.endsWith(".kt")) expect(content, path).not.toMatch(/authenticate|AuthenticationStrategy/);
    }
  });
});
