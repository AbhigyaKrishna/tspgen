import { getNamespaceFullName, NoTarget, type DiagnosticTarget, type Program } from "@typespec/compiler";
import { getAllHttpServices, getAuthentication, type Authentication, type HttpAuth } from "@typespec/http";
import type { AuthIR } from "./ir/types.js";

/** How a client sends a scheme's credential. */
export type AuthKind = "bearer" | "basic" | "apiKey";

/** bearer for http Bearer, OAuth2 and OpenID Connect (tokens only), basic for http Basic, apiKey; else unsupported. */
export function authKind(auth: AuthIR): AuthKind | undefined {
  switch (auth.type) {
    case "http": {
      const scheme = auth.scheme?.toLowerCase();
      return scheme === "bearer" ? "bearer" : scheme === "basic" ? "basic" : undefined;
    }
    case "oauth2":
    case "openIdConnect":
      return "bearer";
    case "apiKey":
      return "apiKey";
    default:
      return undefined;
  }
}

/** Doc comment text of a client credential (`*​/` escaped for JSDoc and KDoc). */
export function authDocs(auth: AuthIR, kind: AuthKind): string {
  if (kind === "basic") return "Username and password, sent as `Authorization: Basic …`.";
  if (kind === "apiKey") {
    const where = auth.in === "query" ? "query parameter" : auth.in === "cookie" ? "cookie" : "header";
    return `API key, sent as the \`${auth.name ?? ""}\` ${where}.`.replace(/\*\//g, "*\\/");
  }
  const what = auth.type === "oauth2" ? "OAuth2 access token" : auth.type === "openIdConnect" ? "OpenID Connect token" : "Bearer token";
  return `${what}, sent as \`Authorization: Bearer …\`.`;
}

/** Lower-cased header a scheme's credential is sent as; undefined for query parameters and cookies. */
export function authHeader(auth: AuthIR, kind: AuthKind): string | undefined {
  if (kind !== "apiKey") return "authorization";
  return (auth.in ?? "header") === "header" ? (auth.name ?? auth.id).toLowerCase() : undefined;
}

/**
 * Headers that one alternative of `options` (all of whose schemes are `supported`) would send several credentials
 * as; each header is reported once, with the scheme ids of its first conflicting alternative.
 */
export function authHeaderConflicts(
  options: readonly (readonly string[])[],
  supported: ReadonlyMap<string, { auth: AuthIR; kind: AuthKind }>,
): { header: string; ids: string[] }[] {
  const conflicts: { header: string; ids: string[] }[] = [];
  const reported = new Set<string>();
  for (const option of options) {
    if (!option.every((id) => supported.has(id))) continue;
    const byHeader = new Map<string, string[]>();
    for (const id of new Set(option)) {
      const { auth, kind } = supported.get(id)!;
      const header = authHeader(auth, kind);
      if (header) byHeader.set(header, [...(byHeader.get(header) ?? []), id]);
    }
    for (const [header, ids] of byHeader) {
      if (ids.length < 2 || reported.has(header)) continue;
      reported.add(header);
      conflicts.push({ header, ids });
    }
  }
  return conflicts;
}

/**
 * The model declaring a scheme, found through the service's `@useAuth` declarations: same type and http scheme,
 * and the IR id is the scheme id possibly with `_` appended (see `AuthIR.id`). NoTarget when not found.
 */
export function authSchemeTarget(program: Program, serviceId: string, auth: AuthIR): DiagnosticTarget | typeof NoTarget {
  const [services] = getAllHttpServices(program);
  const service = services.find((s) => getNamespaceFullName(s.namespace) === serviceId);
  if (!service) return NoTarget;
  const requirements: (Authentication | undefined)[] = [
    getAuthentication(program, service.namespace),
    ...service.operations.map((op) => op.authentication),
  ];
  const schemes: HttpAuth[] = requirements.flatMap((r) => r?.options.flatMap((o) => o.schemes) ?? []);
  const found = schemes.find(
    (scheme) =>
      scheme.type === auth.type &&
      (scheme.type !== "http" || scheme.scheme === auth.scheme) &&
      auth.id.startsWith(scheme.id) &&
      /^_*$/.test(auth.id.slice(scheme.id.length)),
  );
  return found?.model ?? NoTarget;
}
