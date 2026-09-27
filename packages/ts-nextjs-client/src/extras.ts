import { metaNumber, metaObject, type TargetContext } from "@abhigyakrishna/tspgen-core";
import type { TsGroup } from "@abhigyakrishna/tspgen-typescript";

export interface NextOpExtras {
  next?: Record<string, unknown>;
  staleTime?: number;
}

/** Per-operation `typescript:ts-nextjs-client` meta (`next`, `staleTime`), keyed by operation id. */
export function nextExtras(ctx: TargetContext, groups: TsGroup[]): Record<string, NextOpExtras> {
  const extras: Record<string, NextOpExtras> = {};
  for (const g of groups) {
    for (const op of g.operations) {
      const meta = op.meta["typescript:ts-nextjs-client"] ?? {};
      const next = metaObject(ctx.program, meta, "next", op.id);
      const staleTime = metaNumber(ctx.program, meta, "staleTime", op.id);
      extras[op.id] = { ...(next ? { next } : {}), ...(staleTime !== undefined ? { staleTime } : {}) };
    }
  }
  return extras;
}
