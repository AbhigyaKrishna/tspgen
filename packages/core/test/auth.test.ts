import { describe, expect, it } from "vitest";
import { authDocs, authHeader, authHeaderConflicts, authKind, authQueryConflicts, type AuthIR, type AuthKind } from "../src/index.js";

const bearer: AuthIR = { id: "BearerAuth", type: "http", scheme: "Bearer" };
const basic: AuthIR = { id: "BasicAuth", type: "http", scheme: "Basic" };
const digest: AuthIR = { id: "Digest", type: "http", scheme: "Digest" };
const oauth: AuthIR = { id: "OAuth", type: "oauth2" };
const oidc: AuthIR = { id: "Oidc", type: "openIdConnect" };
const query: AuthIR = { id: "Key", type: "apiKey", in: "query", name: "api-key" };
const header: AuthIR = { id: "Partner", type: "apiKey", in: "header", name: "X-Partner" };
const cookie: AuthIR = { id: "Session", type: "apiKey", in: "cookie", name: "sid" };
const authHeaderKey: AuthIR = { id: "Auth2", type: "apiKey", in: "header", name: "Authorization" };

function supported(...schemes: AuthIR[]): Map<string, { auth: AuthIR; kind: AuthKind }> {
  return new Map(schemes.map((auth) => [auth.id, { auth, kind: authKind(auth)! }]));
}

describe("client auth helpers", () => {
  it("maps schemes to how a client sends them", () => {
    expect([bearer, basic, digest, oauth, oidc, query, { id: "None", type: "noAuth" } as AuthIR].map(authKind)).toEqual([
      "bearer",
      "basic",
      undefined,
      "bearer",
      "bearer",
      "apiKey",
      undefined,
    ]);
  });

  it("documents each credential", () => {
    expect(authDocs(bearer, "bearer")).toBe("Bearer token, sent as `Authorization: Bearer …`.");
    expect(authDocs(oauth, "bearer")).toBe("OAuth2 access token, sent as `Authorization: Bearer …`.");
    expect(authDocs(oidc, "bearer")).toBe("OpenID Connect token, sent as `Authorization: Bearer …`.");
    expect(authDocs(basic, "basic")).toBe("Username and password, sent as `Authorization: Basic …`.");
    expect(authDocs(query, "apiKey")).toBe("API key, sent as the `api-key` query parameter.");
    expect(authDocs(cookie, "apiKey")).toBe("API key, sent as the `sid` cookie.");
    expect(authDocs({ ...header, name: "X-*/" }, "apiKey")).toBe("API key, sent as the `X-*\\/` header.");
  });

  it("names the header a credential is sent as", () => {
    expect(authHeader(bearer, "bearer")).toBe("authorization");
    expect(authHeader(basic, "basic")).toBe("authorization");
    expect(authHeader(header, "apiKey")).toBe("x-partner");
    expect(authHeader(query, "apiKey")).toBeUndefined();
    expect(authHeader(cookie, "apiKey")).toBeUndefined();
  });

  it("finds alternatives sending two credentials as one header, once per header", () => {
    const schemes = supported(bearer, basic, authHeaderKey, header, query);
    expect(authHeaderConflicts([["BearerAuth", "BasicAuth"], ["BearerAuth", "Auth2"]], schemes)).toEqual([
      { header: "authorization", ids: ["BearerAuth", "BasicAuth"] },
    ]);
    expect(authHeaderConflicts([["Partner", "Key"], ["BearerAuth"]], schemes)).toEqual([]);
    // Alternatives needing an unsupported scheme are skipped.
    expect(authHeaderConflicts([["BearerAuth", "BasicAuth", "Digest"]], schemes)).toEqual([]);
  });

  it("finds query parameters an API key in the query replaces, once per name", () => {
    const schemes = supported(bearer, header, query);
    const name = query.name!;
    expect(authQueryConflicts([["BearerAuth"], [query.id], [query.id, "BearerAuth"]], schemes, [name, "other"])).toEqual([
      { name, id: query.id },
    ]);
    expect(authQueryConflicts([[query.id]], schemes, ["other"])).toEqual([]);
    expect(authQueryConflicts([[query.id, "Digest"]], schemes, [name])).toEqual([]);
  });
});
