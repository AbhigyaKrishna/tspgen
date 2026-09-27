import { reportDiagnostic, type AuthIR } from "@abhigyakrishna/tspgen-core";
import { propertyKey, reportDiagnostic as reportTsDiagnostic, type TsOperation, type TsService } from "@abhigyakrishna/tspgen-typescript";
import { getNamespaceFullName, NoTarget, type DiagnosticTarget, type Program } from "@typespec/compiler";
import { getAllHttpServices, getAuthentication, type Authentication, type HttpAuth } from "@typespec/http";

/** How the client sends a scheme's credential. */
export type AuthKind = "bearer" | "basic" | "apiKey";

/** One member of the generated `<Service>Auth` type. */
export interface AuthMember {
  /** Property key: the scheme id, quoted when not an identifier. */
  key: string;
  kind: AuthKind;
  docs: string;
}

/** A service's generated client auth: the `<Service>Auth` members and each operation's descriptor. */
export interface ClientAuth {
  members: AuthMember[];
  /** Whether a member takes basic credentials (`{ username, password }`). */
  basic: boolean;
  /**
   * The operation's `RequestSpec.auth` expression: alternatives (in declared order) of schemes the client can
   * send; absent when it has none (no `@useAuth`, NoAuth only, or only unsupported schemes).
   */
  descriptor(op: TsOperation): string | undefined;
}

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

function comment(text: string): string {
  return text.replace(/\*\//g, "*\\/");
}

function memberDocs(auth: AuthIR, kind: AuthKind): string {
  if (kind === "basic") return "Username and password, sent as `Authorization: Basic …`.";
  if (kind === "apiKey") {
    const where = auth.in === "query" ? "query parameter" : auth.in === "cookie" ? "cookie" : "header";
    return comment(`API key, sent as the \`${auth.name ?? ""}\` ${where}.`);
  }
  const what = auth.type === "oauth2" ? "OAuth2 access token" : auth.type === "openIdConnect" ? "OpenID Connect token" : "Bearer token";
  return `${what}, sent as \`Authorization: Bearer …\`.`;
}

const str = (value: string) => JSON.stringify(value);

function schemeExpr(auth: AuthIR, kind: AuthKind): string {
  const location = kind === "apiKey" ? `, in: ${str(auth.in ?? "header")}, name: ${str(auth.name ?? "")}` : "";
  return `{ id: ${str(auth.id)}, kind: ${str(kind)}${location} }`;
}

/**
 * The model declaring an (unsupported) scheme, found through the service's `@useAuth` declarations: same type and
 * http scheme, and the IR id is the scheme id possibly with `_` appended (see `AuthIR.id`). NoTarget when not found.
 */
function schemeTarget(program: Program, serviceId: string, auth: AuthIR): DiagnosticTarget | typeof NoTarget {
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

/** Lower-cased header a scheme's credential is sent as; undefined for query parameters and cookies. */
function headerOf(auth: AuthIR, kind: AuthKind): string | undefined {
  if (kind !== "apiKey") return "authorization";
  return (auth.in ?? "header") === "header" ? (auth.name ?? auth.id).toLowerCase() : undefined;
}

/** Warns, per operation and header, when one alternative sends several credentials as the same header. */
function checkHeaderConflicts(
  program: Program,
  service: TsService,
  supported: Map<string, { auth: AuthIR; kind: AuthKind }>,
  target: string,
): void {
  for (const op of service.groups.flatMap((g) => g.operations)) {
    const reported = new Set<string>();
    for (const option of op.auth?.options ?? []) {
      if (!option.every((id) => supported.has(id))) continue;
      const byHeader = new Map<string, string[]>();
      for (const id of new Set(option)) {
        const { auth, kind } = supported.get(id)!;
        const header = headerOf(auth, kind);
        if (header) byHeader.set(header, [...(byHeader.get(header) ?? []), id]);
      }
      for (const [header, ids] of byHeader) {
        if (ids.length < 2 || reported.has(header)) continue;
        reported.add(header);
        reportTsDiagnostic(program, {
          code: "auth-header-conflict",
          format: { operation: op.id, schemes: ids.join(", "), header, target },
          target: NoTarget,
        });
      }
    }
  }
}

/**
 * Client auth of a service, or undefined when it uses no scheme the client can send. Unsupported schemes (http
 * schemes other than Bearer/Basic) warn once per service; alternatives needing them are dropped. An alternative
 * sending two credentials as the same header warns `auth-header-conflict`.
 */
export function clientAuth(program: Program, service: TsService, target: string): ClientAuth | undefined {
  const supported = new Map<string, { auth: AuthIR; kind: AuthKind }>();
  for (const auth of service.auth) {
    if (auth.type === "noAuth") continue;
    const kind = authKind(auth);
    if (kind) {
      supported.set(auth.id, { auth, kind });
      continue;
    }
    reportDiagnostic(program, {
      code: "unsupported-auth-scheme",
      format: { scheme: auth.id, kind: auth.type === "http" ? `http ${auth.scheme ?? ""}`.trim() : auth.type, target },
      target: schemeTarget(program, service.id, auth),
    });
  }
  if (supported.size === 0) return undefined;
  checkHeaderConflicts(program, service, supported, target);
  const members = [...supported.values()].map(({ auth, kind }) => ({ key: propertyKey(auth.id), kind, docs: memberDocs(auth, kind) }));
  return {
    members,
    basic: members.some((m) => m.kind === "basic"),
    descriptor(op) {
      // An empty (NoAuth) alternative sends nothing; it is what remains when no other one is satisfied.
      const alternatives = (op.auth?.options ?? []).filter((o) => o.length > 0 && o.every((id) => supported.has(id)));
      if (alternatives.length === 0) return undefined;
      const rendered = alternatives.map(
        (o) => `[${[...new Set(o)].map((id) => schemeExpr(supported.get(id)!.auth, supported.get(id)!.kind)).join(", ")}]`,
      );
      return `[${rendered.join(", ")}]`;
    },
  };
}

/** Type of a `<Service>Auth` member: grouped clients use core's `AuthProvider`, the flat client spells it out. */
export function memberType(kind: AuthKind, style: "grouped" | "flat"): string {
  if (style === "grouped") return kind === "basic" ? "AuthProvider<BasicCredentials>" : "AuthProvider<string>";
  const credential = kind === "basic" ? "{ username: string; password: string }" : "string";
  return `() => ${credential} | undefined | Promise<${credential} | undefined>`;
}
