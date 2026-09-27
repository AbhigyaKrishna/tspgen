import { metaObjects, metaStrings, type MetaData } from "@abhigyakrishna/tspgen-core";
import { fqnTypeUse, identifier, type KtOperation, type KtTypeUse } from "@abhigyakrishna/tspgen-kotlin";
import type { Program } from "@typespec/compiler";
import type { SseMode } from "./sse.js";
import type { ServerUpload } from "./uploads.js";

/** A service parameter supplied by a route-handler expression instead of the HTTP request. */
export interface ContextParam {
  name: string;
  type: KtTypeUse;
  /** Kotlin expression evaluated in the route handler (`call` in scope). */
  expr: string;
}

/** An operation as the server sees it: replaced parameters removed, context parameters appended. */
export interface ServerOperation extends KtOperation {
  context: ContextParam[];
  /** How a multipart or file body is received; absent for JSON bodies. */
  upload?: ServerUpload;
  /** How a server-sent event stream is written; set only on streaming operations. */
  sse?: SseMode;
}

function plain(name: string): string {
  return name.replace(/`/g, "");
}

/**
 * Apply `context` entries (`{ name, type, expr, replaces? }[]`, later entries win by name). An entry with
 * `replaces` applies only when the operation has all of those parameters.
 */
export function withContext(program: Program, op: KtOperation, meta: MetaData): ServerOperation {
  const entries = new Map<string, MetaData>();
  for (const entry of metaObjects(program, meta, "context", op.id)) {
    if (typeof entry.name !== "string" || typeof entry.type !== "string" || typeof entry.expr !== "string") {
      throw new Error(`context entries on '${op.id}' need string 'name', 'type' and 'expr'`);
    }
    entries.set(entry.name, entry);
  }
  const available = new Set(op.params.flatMap((p) => [plain(p.name), p.wireName]));
  const pathParams = new Set(
    op.params.filter((p) => p.location === "path").flatMap((p) => [plain(p.name), p.wireName]),
  );
  const replaced = new Set<string>();
  const context: ContextParam[] = [];
  for (const entry of entries.values()) {
    const name = entry.name as string;
    const replaces = metaStrings(program, entry, "replaces", op.id);
    for (const r of replaces) {
      if (pathParams.has(r)) {
        throw new Error(`context '${name}' on '${op.id}' cannot replace path parameter '${r}'`);
      }
    }
    if (!replaces.every((r) => available.has(r))) continue;
    for (const r of replaces) replaced.add(r);
    context.push({ name: identifier(name), type: fqnTypeUse(entry.type as string), expr: entry.expr as string });
  }
  const params = op.params.filter((p) => !replaced.has(plain(p.name)) && !replaced.has(p.wireName));
  const taken = new Set([
    "call",
    "service",
    "resource",
    ...params.map((p) => plain(p.name)),
    ...(op.body ? [plain(op.body.name)] : []),
  ]);
  for (const c of context) {
    const name = plain(c.name);
    if (taken.has(name)) throw new Error(`context parameter '${name}' clashes with a parameter of '${op.id}'`);
  }
  return { ...op, params, context };
}
