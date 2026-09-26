import { camel, typeName, type KtOperation, type KtService } from "@specgen/emitter-kotlin";
import type { KtorServerOptions } from "./options.js";

/** One service interface + routes file. */
export interface ServerUnit {
  name: string;
  serviceName: string;
  routesFn: string;
  resourcesObject: string;
  operations: KtOperation[];
}

export function buildUnits(service: KtService, grouping: KtorServerOptions["grouping"]): ServerUnit[] {
  const buckets = new Map<string, KtOperation[]>();
  for (const group of service.groups) {
    const key =
      grouping === "single-file"
        ? service.name
        : grouping === "per-namespace"
          ? typeName(group.namespace.at(-1) ?? service.name)
          : group.name;
    buckets.set(key, [...(buckets.get(key) ?? []), ...group.operations]);
  }
  return [...buckets].map(([name, operations]) => {
    const seen = new Set<string>();
    for (const op of operations) {
      if (seen.has(op.name)) {
        throw new Error(`operation '${op.name}' appears twice in '${name}'; use grouping "per-interface" or @Kotlin.name`);
      }
      seen.add(op.name);
    }
    return {
      name,
      serviceName: `${name}Service`,
      routesFn: `${camel(name)}Routes`,
      resourcesObject: `${name}Resources`,
      operations,
    };
  });
}
