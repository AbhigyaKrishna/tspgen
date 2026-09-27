import {
  authDocs,
  authHeader,
  authHeaderConflicts,
  authKind,
  authSchemeTarget,
  reportDiagnostic,
  type AuthIR,
  type AuthKind,
} from "@abhigyakrishna/tspgen-core";
import { camel, identifier, kotlinString as str, type KtOperation, type KtService } from "@abhigyakrishna/tspgen-kotlin";
import { NoTarget, type Program } from "@typespec/compiler";

const TARGET = "the Ktor client";

type Supported = Map<string, { auth: AuthIR; kind: AuthKind }>;

/** One property of the generated `<Service>Auth` class. */
export interface AuthMember {
  property: string;
  type: string;
  docs: string;
}

/** A service's generated client auth. */
export interface ServiceAuth {
  className: string;
  members: AuthMember[];
  /** Some scheme is http Basic: `BasicCredentials` and the BASIC placement are emitted. */
  basic: boolean;
  /**
   * The `val <variable> = resolveAuth(<alternatives>)` of an operation in `<groupClass>`; undefined when it sends no
   * credentials (no `@useAuth`, NoAuth only, or only unsupported schemes).
   */
  op(op: KtOperation, groupClass: string): { variable: string; alternatives: string } | undefined;
}

function placement(auth: AuthIR, kind: AuthKind): string {
  if (kind === "bearer") return "BEARER";
  if (kind === "basic") return "BASIC";
  return auth.in === "query" ? "QUERY" : auth.in === "cookie" ? "COOKIE" : "HEADER";
}

/** Warns about credentials colliding on one header: within an alternative, or with a header parameter. */
function checkConflicts(program: Program, op: KtOperation, supported: Supported): void {
  for (const { header, ids } of authHeaderConflicts(op.auth?.options ?? [], supported)) {
    reportDiagnostic(program, {
      code: "auth-header-conflict",
      messageId: "default",
      format: { operation: op.id, schemes: ids.join(", "), header, target: TARGET },
      target: NoTarget,
    });
  }
  const params = new Set(op.params.filter((p) => p.location === "header").map((p) => p.wireName.toLowerCase()));
  const reported = new Set<string>();
  for (const option of op.auth?.options ?? []) {
    if (!option.every((id) => supported.has(id))) continue;
    for (const id of new Set(option)) {
      const { auth, kind } = supported.get(id)!;
      const header = authHeader(auth, kind);
      if (!header || !params.has(header) || reported.has(header)) continue;
      reported.add(header);
      reportDiagnostic(program, {
        code: "auth-header-conflict",
        messageId: "parameter",
        format: { operation: op.id, header, scheme: id, target: TARGET },
        target: NoTarget,
      });
    }
  }
}

/**
 * Client auth of a service, or undefined when it uses no scheme the client can send. Unsupported schemes warn
 * `unsupported-auth-scheme` (once per service); alternatives needing them are dropped, as in ts-nextjs-client.
 */
export function serviceAuth(program: Program, service: KtService): ServiceAuth | undefined {
  const supported: Supported = new Map();
  for (const auth of service.auth) {
    if (auth.type === "noAuth") continue;
    const kind = authKind(auth);
    if (kind) {
      supported.set(auth.id, { auth, kind });
      continue;
    }
    reportDiagnostic(program, {
      code: "unsupported-auth-scheme",
      format: { scheme: auth.id, kind: auth.type === "http" ? `http ${auth.scheme ?? ""}`.trim() : auth.type, target: TARGET },
      target: authSchemeTarget(program, service.id, auth),
    });
  }
  if (supported.size === 0) return undefined;
  for (const op of service.groups.flatMap((g) => g.operations)) checkConflicts(program, op, supported);
  // camel-cased scheme ids; ids differing only in `_` suffixes (ApiKeyAuth, ApiKeyAuth_) get a number.
  const taken = new Set<string>();
  const property = new Map<string, string>();
  for (const id of supported.keys()) {
    const base = camel(id);
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
    taken.add(name);
    property.set(id, identifier(name));
  }
  const members = [...supported].map(([id, { auth, kind }]) => ({
    property: property.get(id)!,
    type: kind === "basic" ? "(suspend () -> BasicCredentials?)?" : "(suspend () -> String?)?",
    docs: authDocs(auth, kind),
  }));
  return {
    className: `${service.name}Auth`,
    members,
    basic: [...supported.values()].some((s) => s.kind === "basic"),
    op(op, groupClass) {
      // An empty (NoAuth) alternative sends nothing; it is what remains when no other one is satisfied.
      const alternatives = (op.auth?.options ?? []).filter((o) => o.length > 0 && o.every((id) => supported.has(id)));
      if (alternatives.length === 0) return undefined;
      const names = new Set([...op.params.map((p) => p.name.replace(/`/g, "")), ...(op.body ? [op.body.name.replace(/`/g, "")] : [])]);
      const receiver = names.has("auth") ? `this@${groupClass}.auth` : "auth";
      const scheme = (id: string): string => {
        const { auth, kind } = supported.get(id)!;
        const name = kind === "apiKey" ? (auth.name ?? auth.id) : "Authorization";
        return `AuthScheme(${str(id)}, AuthPlacement.${placement(auth, kind)}, ${str(name)}, ${receiver}?.${property.get(id)})`;
      };
      const list = alternatives.map((o) => `listOf(${[...new Set(o)].map(scheme).join(", ")})`);
      return { variable: names.has("credentials") ? "authCredentials" : "credentials", alternatives: `listOf(${list.join(", ")})` };
    },
  };
}
