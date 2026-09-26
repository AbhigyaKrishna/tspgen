import type { KtOperation } from "@abhigyakrishna/tspgen-kotlin";

/** A route handler, or a wrapper call (e.g. `authenticate("jwt")`) whose block holds nested nodes. */
export type RouteNode =
  | { kind: "route"; op: KtOperation; path: string }
  | { kind: "block"; wrapper: string; children: RouteNode[] };

/** One generated `fun Route.<name>(service: …)`. */
export interface RouteFunction {
  name: string;
  /** Wrap the body in `route(prefix) { }`; routes then use paths relative to it. */
  prefix?: string;
  nodes: RouteNode[];
}

export interface RouteItem {
  op: KtOperation;
  path: string;
  /** Wrapper calls, outermost first. */
  chain: string[];
}

/**
 * Wrapper tree: all items whose chains start with the same wrapper share one block, placed where the first of
 * them appears; order is otherwise preserved (Ktor resolves routes by specificity, not declaration order).
 */
export function routeTree(items: readonly RouteItem[]): RouteNode[] {
  const order: (RouteItem | string)[] = [];
  const blocks = new Map<string, RouteItem[]>();
  for (const item of items) {
    const [head, ...rest] = item.chain;
    if (head === undefined) {
      order.push(item);
      continue;
    }
    let block = blocks.get(head);
    if (!block) {
      block = [];
      blocks.set(head, block);
      order.push(head);
    }
    block.push({ ...item, chain: rest });
  }
  return order.map((entry) =>
    typeof entry === "string"
      ? { kind: "block", wrapper: entry, children: routeTree(blocks.get(entry)!) }
      : { kind: "route", op: entry.op, path: entry.path },
  );
}

/** Longest common prefix of literal path segments (stops at the first `{param}`); "" when none. */
export function commonPrefix(paths: readonly string[]): string {
  const split = paths.map((p) => p.split("/").filter(Boolean));
  const first = split[0] ?? [];
  let n = 0;
  while (n < first.length && !first[n].startsWith("{") && split.every((segments) => segments[n] === first[n])) n++;
  return n === 0 ? "" : `/${first.slice(0, n).join("/")}`;
}
