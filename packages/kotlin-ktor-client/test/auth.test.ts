import { expectDiagnostics } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { client, sseClient, TARGET, Tester } from "./tester.js";

const DIR = "client/com/acme/client";

const authSpec = `
  @service @useAuth(BearerAuth) namespace Shop;
  model Key is ApiKeyAuth<ApiKeyLocation.query, "api-key">;
  model Session is ApiKeyAuth<ApiKeyLocation.cookie, "sid">;
  model Partner is ApiKeyAuth<ApiKeyLocation.header, "X-Partner">;
  @route("/items") interface Items {
    @get list(): string[];
    @post @useAuth(NoAuth) create(): void;
    @get @route("/either") @useAuth(BasicAuth | Key | NoAuth) either(): void;
    @get @route("/both") @useAuth([Session, Partner]) both(): void;
  }
`;

describe("ktor client generated auth", () => {
  it("declares <Service>Auth and passes it through the API client", async () => {
    const api = (await client().compile(authSpec)).outputs[`${DIR}/ShopApiClient.kt`];
    expect(api).toContain(`class ShopApiClient(http: HttpClient, baseUrl: String, auth: ShopAuth? = null) {
    val items = ItemsClient(http, baseUrl, auth)
}

/**
 * Credentials of the Shop API by auth scheme. Each provider is called at most once per request and may return
 * null (no credential); an operation sends the first of its \`@useAuth\` alternatives whose providers all return one.
 */
class ShopAuth(
    /** Bearer token, sent as \`Authorization: Bearer …\`. */
    val bearerAuth: (suspend () -> String?)? = null,
    /** Username and password, sent as \`Authorization: Basic …\`. */
    val basicAuth: (suspend () -> BasicCredentials?)? = null,
    /** API key, sent as the \`api-key\` query parameter. */
    val key: (suspend () -> String?)? = null,
    /** API key, sent as the \`sid\` cookie. */
    val session: (suspend () -> String?)? = null,
    /** API key, sent as the \`X-Partner\` header. */
    val partner: (suspend () -> String?)? = null,
)
`);
  });

  it("resolves each operation's alternatives and applies them last in the request", async () => {
    const items = (await client().compile(authSpec)).outputs[`${DIR}/ItemsClient.kt`];
    expect(items).toContain(`class ItemsClient(
    private val http: HttpClient,
    private val baseUrl: String,
    private val auth: ShopAuth? = null,
) {
    suspend fun list(): List<String> {
        val credentials = resolveAuth(listOf(listOf(AuthScheme("BearerAuth", AuthPlacement.BEARER, "Authorization", auth?.bearerAuth))))
        val response = http.request {
            expectSuccess = false
            method = HttpMethod.Get
            url {
                takeFrom(baseUrl)
                appendPathSegments("items")
            }
            applyAuth(credentials)
        }
`);
    // NoAuth only: nothing resolved.
    expect(items).toContain(`    suspend fun create() {
        val response = http.request {`);
    // A | B | NoAuth: the NoAuth alternative is what remains when neither is satisfied.
    expect(items).toContain(
      `        val credentials = resolveAuth(listOf(listOf(AuthScheme("BasicAuth", AuthPlacement.BASIC, "Authorization", auth?.basicAuth)), listOf(AuthScheme("Key", AuthPlacement.QUERY, "api-key", auth?.key))))\n`,
    );
    // A & B.
    expect(items).toContain(
      `        val credentials = resolveAuth(listOf(listOf(AuthScheme("Session", AuthPlacement.COOKIE, "sid", auth?.session), AuthScheme("Partner", AuthPlacement.HEADER, "X-Partner", auth?.partner))))\n`,
    );
  });

  it("emits the auth runtime in ClientSupport.kt", async () => {
    const support = (await client().compile(authSpec)).outputs[`${DIR}/ClientSupport.kt`];
    expect(support).toContain(`data class BasicCredentials(val username: String, val password: String)`);
    expect(support).toContain("internal enum class AuthPlacement { BEARER, BASIC, HEADER, QUERY, COOKIE }\n");
    expect(support).toContain(`internal suspend fun resolveAuth(alternatives: List<List<AuthScheme>>): List<Pair<AuthScheme, Any>> {
    val values = HashMap<String, Any?>()
    for (alternative in alternatives) {
        val found = ArrayList<Pair<AuthScheme, Any>>()
        for (scheme in alternative) {
            val value = if (scheme.id in values) values[scheme.id] else scheme.provider?.invoke().also { values[scheme.id] = it }
            if (value == null || value == "") break
            found += scheme to value
        }
        if (found.size == alternative.size) return found
    }
    return emptyList()
}`);
    expect(support).toContain(`            AuthPlacement.BASIC -> {
                val basic = value as BasicCredentials
                headers[HttpHeaders.Authorization] = "Basic " + "\${basic.username}:\${basic.password}".encodeBase64()
            }`);
    for (const i of ["io.ktor.client.request.HttpRequestBuilder", "io.ktor.client.request.cookie", "io.ktor.http.HttpHeaders", "io.ktor.util.encodeBase64"]) {
      expect(support).toContain(`import ${i}\n`);
    }
  });

  it("omits BasicCredentials and the BASIC placement without http Basic", async () => {
    const support = (await client().compile(authSpec.replace("BasicAuth | ", ""))).outputs[`${DIR}/ClientSupport.kt`];
    expect(support).not.toContain("BasicCredentials");
    expect(support).toContain("internal enum class AuthPlacement { BEARER, HEADER, QUERY, COOKIE }\n");
    expect(support).not.toContain("encodeBase64");
  });

  it("changes nothing for APIs without @useAuth or with features.auth off", async () => {
    const plain = (await client().compile(`@service namespace S; @route("/p") op ping(): void;`)).outputs;
    expect(plain[`${DIR}/SApiClient.kt`]).toContain("class SApiClient(http: HttpClient, baseUrl: String) {");
    expect(plain[`${DIR}/ClientSupport.kt`]).not.toContain("resolveAuth");
    const off = (await client({ features: { auth: false } }).compile(authSpec)).outputs;
    expect(off[`${DIR}/ShopApiClient.kt`]).not.toContain("ShopAuth");
    expect(off[`${DIR}/ItemsClient.kt`]).not.toContain("resolveAuth");
    expect(off[`${DIR}/ClientSupport.kt`]).not.toContain("AuthScheme");
  });

  it("warns about unsupported schemes and drops the alternatives needing them", async () => {
    const [{ outputs }, diagnostics] = await client().compileAndDiagnose(`
      @service namespace S;
      model Digest { type: AuthType.http; scheme: "Digest" }
      @route("/a") interface A {
        @get @useAuth(Digest | BearerAuth) a(): void;
        @get @route("/d") @useAuth(Digest) d(): void;
      }
    `);
    expectDiagnostics(diagnostics, {
      code: "@abhigyakrishna/tspgen-core/unsupported-auth-scheme",
      severity: "warning",
      message: "Auth scheme 'Digest' (http Digest) is not supported by the Ktor client; alternatives needing it are ignored.",
    });
    const a = outputs[`${DIR}/AClient.kt`];
    expect(a).toContain(`resolveAuth(listOf(listOf(AuthScheme("BearerAuth", AuthPlacement.BEARER, "Authorization", auth?.bearerAuth))))`);
    expect(a.match(/resolveAuth/g)).toHaveLength(1);
    expect(outputs[`${DIR}/SApiClient.kt`]).not.toContain("digest");
  });

  it("warns when credentials collide on one header", async () => {
    const [, diagnostics] = await client().compileAndDiagnose(`
      @service namespace S;
      model Partner is ApiKeyAuth<ApiKeyLocation.header, "X-Partner">;
      @route("/a") interface A {
        @get @useAuth([BearerAuth, BasicAuth]) a(): void;
        @get @route("/b") @useAuth(Partner) b(@header("x-partner") partner: string): void;
      }
    `);
    expectDiagnostics(diagnostics, [
      {
        code: "@abhigyakrishna/tspgen-core/auth-header-conflict",
        message: "Operation 'S.A.a' sends several credentials (BearerAuth, BasicAuth) as the 'authorization' header in one auth alternative; the Ktor client sends only the last one.",
      },
      {
        code: "@abhigyakrishna/tspgen-core/auth-header-conflict",
        message: "Operation 'S.A.b' has a 'x-partner' header parameter, which auth scheme 'Partner' also sends; the Ktor client sends the credential instead.",
      },
    ]);
  });

  it("qualifies the auth property and renames the local when parameters use their names", async () => {
    const items = (
      await client().compile(`
        @service @useAuth(BearerAuth) namespace S;
        @route("/a") op a(@query auth: string, @query credentials: string): void;
      `)
    ).outputs[`${DIR}/SClient.kt`];
    expect(items).toContain(
      `        val authCredentials = resolveAuth(listOf(listOf(AuthScheme("BearerAuth", AuthPlacement.BEARER, "Authorization", this@SClient.auth?.bearerAuth))))\n`,
    );
    expect(items).toContain("            applyAuth(authCredentials)\n");
  });

  it("resolves credentials inside a stream's flow, per collection", async () => {
    const feed = (
      await sseClient().compile(`
        @service @useAuth(BearerAuth) namespace S;
        @events union Ticks { tick: int32 }
        @route("/feed") op feed(): SSEStream<Ticks>;
      `)
    ).outputs[`${DIR}/SClient.kt`];
    expect(feed).toContain(`    fun feed(): Flow<Ticks> = flow {
        val json = http.apiJson
        val credentials = resolveAuth(listOf(listOf(AuthScheme("BearerAuth", AuthPlacement.BEARER, "Authorization", auth?.bearerAuth))))
        http.prepareRequest {
            expectSuccess = false
            method = HttpMethod.Get
            url {
                takeFrom(baseUrl)
                appendPathSegments("feed")
            }
            header(HttpHeaders.Accept, "text/event-stream")
            applyAuth(credentials)
        }.execute { response ->`);
  });

  it("follows visibility: internal", async () => {
    const { outputs } = await Tester.emit("@abhigyakrishna/tspgen-kotlin", {
      package: "com.acme",
      visibility: "internal",
      targets: [{ [TARGET]: {} }],
    }).compile(authSpec);
    expect(outputs[`${DIR}/ShopApiClient.kt`]).toContain("\ninternal class ShopAuth(");
    expect(outputs[`${DIR}/ClientSupport.kt`]).toContain("\ninternal data class BasicCredentials(");
  });
});
