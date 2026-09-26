import { camel, typeName, type KtOperation, type KtService } from "@tspgen/emitter-kotlin";
import type { ServerOperation } from "./context.js";
import type { KtorServerOptions } from "./options.js";

/** One service interface + routes file. */
export interface ServerUnit {
  name: string;
  serviceName: string;
  routesFn: string;
  resourcesObject: string;
  /** Package mapped from the unit's namespace; the target package is used when absent. */
  package?: string;
  operations: ServerOperation[];
}

export function buildUnits(
  service: KtService,
  grouping: KtorServerOptions["grouping"],
  serviceSuffix = "Service",
): ServerUnit[] {
  const buckets = new Map<string, { operations: KtOperation[]; packages: (string | undefined)[] }>();
  for (const group of service.groups) {
    const key =
      grouping === "single-file"
        ? service.name
        : grouping === "per-namespace"
          ? typeName(group.namespace.at(-1) ?? service.name)
          : group.name;
    const bucket = buckets.get(key) ?? { operations: [], packages: [] };
    bucket.operations.push(...group.operations);
    bucket.packages.push(group.package);
    buckets.set(key, bucket);
  }
  return [...buckets].map(([name, bucket]) => {
    const seen = new Set<string>();
    for (const op of bucket.operations) {
      if (seen.has(op.name)) {
        throw new Error(`operation '${op.name}' appears twice in '${name}'; use grouping "per-interface" or @Kotlin.name`);
      }
      seen.add(op.name);
    }
    // A unit lives in a mapped package only when every group in it maps to the same one.
    const [pkg] = bucket.packages;
    const shared = pkg !== undefined && bucket.packages.every((p) => p === pkg) ? pkg : undefined;
    return {
      name,
      serviceName: `${name}${serviceSuffix}`,
      routesFn: `${camel(name)}Routes`,
      resourcesObject: `${name}Resources`,
      ...(shared ? { package: shared } : {}),
      operations: bucket.operations.map((op) => ({ ...op, context: [] })),
    };
  });
}
