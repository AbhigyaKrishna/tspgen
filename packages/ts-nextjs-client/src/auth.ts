import {
  authDocs,
  authHeaderConflicts,
  authKind,
  authQueryConflicts,
  operationTarget,
  authSchemeTarget,
  reportDiagnostic,
  type AuthIR,
  type AuthKind,
} from "@abhigyakrishna/tspgen-core";
import { propertyKey, type TsOperation, type TsService } from "@abhigyakrishna/tspgen-typescript";
import type { Program } from "@typespec/compiler";

export type { AuthKind };

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

const str = (value: string) => JSON.stringify(value);

function schemeExpr(auth: AuthIR, kind: AuthKind): string {
  const location = kind === "apiKey" ? `, in: ${str(auth.in ?? "header")}, name: ${str(auth.name ?? "")}` : "";
  return `{ id: ${str(auth.id)}, kind: ${str(kind)}${location} }`;
}

/**
 * Warns (core's `auth-header-conflict`), per operation and header, when one alternative sends several credentials as
 * the same header, and per query parameter an API key in the query replaces.
 */
function checkHeaderConflicts(
  program: Program,
  service: TsService,
  supported: Map<string, { auth: AuthIR; kind: AuthKind }>,
  target: string,
): void {
  for (const op of service.groups.flatMap((g) => g.operations)) {
    for (const { header, ids } of authHeaderConflicts(op.auth?.options ?? [], supported)) {
      reportDiagnostic(program, {
        code: "auth-header-conflict",
        messageId: "default",
        format: { operation: op.id, schemes: ids.join(", "), header, target },
        target: operationTarget(program, op.id),
      });
    }
    const query = op.params.filter((p) => p.location === "query").map((p) => p.wireName);
    for (const { name, id } of authQueryConflicts(op.auth?.options ?? [], supported, query)) {
      reportDiagnostic(program, {
        code: "auth-header-conflict",
        messageId: "parameter",
        format: { operation: op.id, header: name, location: "query", scheme: id, target },
        target: operationTarget(program, op.id),
      });
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
      target: authSchemeTarget(program, service.id, auth),
    });
  }
  if (supported.size === 0) return undefined;
  checkHeaderConflicts(program, service, supported, target);
  const members = [...supported.values()].map(({ auth, kind }) => ({ key: propertyKey(auth.id), kind, docs: authDocs(auth, kind) }));
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
