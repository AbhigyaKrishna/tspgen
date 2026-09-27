import type { FileSpec, TargetContext } from "@abhigyakrishna/tspgen-core";
import { renderImports, type TsImport, type TsIR, type TsOperation, type TsService } from "@abhigyakrishna/tspgen-typescript";
import { nextExtras } from "./extras.js";
import { nextjsHelpers as h, queryObjectType } from "./helpers.js";
import { names } from "./names.js";

/**
 * Names queries.ts and hooks.ts import or use besides generated ones (TanStack Query, React, the globals the
 * hooks' types use); a generated type with one of these names would clash with them.
 */
export const REACT_QUERY_INTERNALS = [
  "queryOptions",
  "useQuery",
  "useMutation",
  "UseQueryOptions",
  "UseMutationOptions",
  "createContext",
  "createElement",
  "useContext",
  "ReactNode",
  "Omit",
  "ReturnType",
];

export interface FlatVarsField {
  key: string;
  type: string;
  optional: boolean;
  docs?: string;
}

export interface FlatRqOperation {
  name: string;
  /** `<Op>Vars`; absent when the operation has no inputs (hooks and query options then take none). */
  vars?: string;
  fields: FlatVarsField[];
  /** `vars: <Op>Vars`, `vars: <Op>Vars = {}` when every key is optional, or "". */
  varsDecl: string;
  /** The method's positional arguments read from `vars` (path params, body, query object; no init). */
  args: string[];
  /** Data type: the result type, `null` for a void query (TanStack Query rejects `undefined` data). */
  data: string;
  /** A void query: its queryFn awaits the method and resolves `null`. */
  void: boolean;
  hook: string;
  staleTime?: number;
  docs?: string;
  deprecated?: string;
}

export interface FlatRqGroup {
  prop: string;
  queries: FlatRqOperation[];
  mutations: FlatRqOperation[];
}

export interface FlatRqService {
  name: string;
  client: string;
  keys: string;
  queriesName: string;
  provider: string;
  context: string;
  useClient: string;
  groups: FlatRqGroup[];
}

/** GET/HEAD operations become queries; everything else (uploads included) mutations. */
export function isFlatQuery(op: TsOperation): boolean {
  return h.isQuery(op) && !h.isUpload(op);
}

const pathParams = (op: TsOperation) => op.params.filter((p) => p.location === "path");
const queryParams = (op: TsOperation) => op.params.filter((p) => p.location === "query");

/** Operations that get React Query code: not server-sent event streams (async generators), nor `varsKeyClash`. */
export function hasReactQuery(op: TsOperation): boolean {
  return !h.isStream(op) && varsKeyClash(op) === undefined;
}

/**
 * Why `<Op>Vars` cannot be generated: its fixed `body` / `query` keys would collide with a path parameter's.
 * Vars keys are the public parameter names (a path param renamed inside the method for `validate` keeps its name).
 */
export function varsKeyClash(op: TsOperation): string | undefined {
  for (const p of pathParams(op)) {
    if (p.name === "body" && op.body) return "path parameter 'body' clashes with the 'body' key of its React Query variables";
    if (p.name === "query" && queryParams(op).length > 0) {
      return "path parameter 'query' clashes with the 'query' key of its React Query variables";
    }
  }
  return undefined;
}

/**
 * Every name the React Query files declare (exported or module-level) plus the query-key paths
 * (`shopKeys.nodes.all`, `shopKeys.nodes.readNode`), each with the TypeSpec id that produces it.
 */
export function reactQueryNames(services: readonly TsService[]): { name: string; owner: string; exported: boolean }[] {
  const out: { name: string; owner: string; exported: boolean }[] = [];
  for (const s of services) {
    const keys = names.keys(s);
    out.push(
      { name: keys, owner: s.id, exported: true },
      { name: names.queries(s), owner: s.id, exported: true },
      { name: names.provider(s), owner: s.id, exported: true },
      { name: names.useClient(s), owner: s.id, exported: true },
      { name: names.context(s), owner: s.id, exported: false },
      { name: `${keys}.all`, owner: s.id, exported: false },
    );
    for (const g of s.groups) {
      const prop = `${keys}.${names.groupProperty(g)}`;
      out.push({ name: prop, owner: g.id, exported: false }, { name: `${prop}.all`, owner: g.id, exported: false });
      for (const op of g.operations.filter(hasReactQuery)) {
        if (hasInputs(op)) out.push({ name: names.flatVars(op), owner: op.id, exported: true });
        if (isFlatQuery(op)) {
          out.push({ name: names.flatQueryHook(op), owner: op.id, exported: true }, { name: `${prop}.${op.name}`, owner: op.id, exported: false });
        } else {
          out.push({ name: names.flatMutationHook(op), owner: op.id, exported: true });
        }
      }
    }
  }
  return out;
}

function hasInputs(op: TsOperation): boolean {
  return op.body !== undefined || op.params.some((p) => p.location === "path" || p.location === "query");
}

function operation(op: TsOperation, query: boolean, staleTime: number | undefined): FlatRqOperation {
  const path = pathParams(op);
  const q = queryParams(op);
  const queryRequired = q.some((p) => !p.optional);
  const fields: FlatVarsField[] = [
    ...path.map((p) => ({ key: p.name, type: p.type.text, optional: false, ...(p.docs ? { docs: p.docs } : {}) })),
    ...(op.body ? [{ key: "body", type: op.body.type.text, optional: op.body.optional, ...(op.body.docs ? { docs: op.body.docs } : {}) }] : []),
    ...(q.length > 0 ? [{ key: "query", type: queryObjectType(q), optional: !queryRequired, docs: "Query parameters." }] : []),
  ];
  const vars = fields.length > 0 ? names.flatVars(op) : undefined;
  return {
    name: op.name,
    ...(vars ? { vars } : {}),
    fields,
    varsDecl: vars ? `vars: ${vars}${fields.every((f) => f.optional) ? " = {}" : ""}` : "",
    args: [...path.map((p) => `vars.${p.name}`), ...(op.body ? ["vars.body"] : []), ...(q.length > 0 ? ["vars.query"] : [])],
    data: query && op.result.type.text === "void" ? "null" : op.result.type.text,
    void: query && op.result.type.text === "void",
    hook: query ? names.flatQueryHook(op) : names.flatMutationHook(op),
    ...(query && staleTime !== undefined ? { staleTime } : {}),
    ...(op.docs ? { docs: op.docs } : {}),
    ...(op.deprecated ? { deprecated: op.deprecated } : {}),
  };
}

const external = (name: string, from: string, typeOnly: boolean): TsImport => ({ name, from, typeOnly, external: true });
const local = (name: string, from: string, typeOnly: boolean): TsImport => ({ name, from, typeOnly });

/** queries.ts (server-safe; re-exported by index.ts) and hooks.ts ("use client"; imported as ./hooks). */
export function planFlatReactQuery(
  ir: TsIR & { modelsPrefix?: string },
  services: readonly TsService[],
  ctx: TargetContext,
): FileSpec[] {
  const extras = nextExtras(ctx, services.flatMap((s) => s.groups));
  const data: FlatRqService[] = services.map((s) => ({
    name: s.name,
    client: `${s.name}Client`,
    keys: names.keys(s),
    queriesName: names.queries(s),
    provider: names.provider(s),
    context: names.context(s),
    useClient: names.useClient(s),
    groups: s.groups.map((g) => ({
      prop: names.groupProperty(g),
      queries: g.operations.filter((op) => isFlatQuery(op) && hasReactQuery(op)).map((op) => operation(op, true, extras[op.id]?.staleTime)),
      mutations: g.operations.filter((op) => !isFlatQuery(op) && hasReactQuery(op)).map((op) => operation(op, false, undefined)),
    })),
  }));
  const all = services.flatMap((s) => s.groups.flatMap((g) => g.operations.filter(hasReactQuery)));
  const withVars = all.filter(hasInputs);
  const rqOps = data.flatMap((s) => s.groups.flatMap((g) => [...g.queries, ...g.mutations]));
  const hasQueries = (s: FlatRqService) => s.groups.some((g) => g.queries.length > 0);
  const anyQuery = data.some(hasQueries);
  const anyMutation = data.some((s) => s.groups.some((g) => g.mutations.length > 0));
  const ext = ir.importExtension;
  const prefix = ir.modelsPrefix ?? "";

  const queriesImports: TsImport[] = [
    ...(anyQuery ? [external("queryOptions", "@tanstack/react-query", false)] : []),
    ...data.filter(hasQueries).map((s) => local(s.client, "client", true)),
    ...withVars.flatMap((op) => [...op.params.flatMap((p) => (p.location === "path" || p.location === "query" ? p.type.imports : [])), ...(op.body?.type.imports ?? [])]),
  ];
  const hooksImports: TsImport[] = [
    ...(anyQuery ? [external("useQuery", "@tanstack/react-query", false), external("UseQueryOptions", "@tanstack/react-query", true)] : []),
    ...(anyMutation ? [external("useMutation", "@tanstack/react-query", false), external("UseMutationOptions", "@tanstack/react-query", true)] : []),
    external("createContext", "react", false),
    external("createElement", "react", false),
    external("useContext", "react", false),
    external("ReactNode", "react", true),
    ...data.map((s) => local(s.client, "client", true)),
    ...data.filter(hasQueries).flatMap((s) => [local(s.keys, "queries", false), local(s.queriesName, "queries", false)]),
    ...rqOps.flatMap((op) => (op.vars ? [local(op.vars, "queries", true)] : [])),
    ...all.flatMap((op) => op.result.type.imports),
  ];
  const file = (path: string, imports: TsImport[], body: string, directive?: string): FileSpec => ({
    path: `${path}.ts`,
    template: "ts/file",
    data: { imports: renderImports(path, imports, ext, prefix), body, services: data, ...(directive ? { directive } : {}) },
  });
  return [file("queries", queriesImports, "ts-nextjs/flat-queries"), file("hooks", hooksImports, "ts-nextjs/flat-hooks", "use client")];
}
