import { NoTarget, type Program } from "@typespec/compiler";
import { reportDiagnostic } from "../lib.js";
import type { ApiIR, TypeIR } from "./types.js";

export interface SelectionOptions {
  "model-collection"?: "all" | "reachable";
  "include-services"?: string[];
  "include-operations"?: string[];
  "include-types"?: string[];
}

/** Selection is applied to the resolved version, before language transforms and plugins. */
export function selectApi(program: Program, api: ApiIR, options: SelectionOptions): ApiIR {
  const matches = (selected: string[] | undefined, available: string[], option: string): Set<string> | undefined => {
    if (!selected) return undefined;
    for (const id of selected) {
      if (!available.includes(id)) reportDiagnostic(program, { code: "invalid-selection", format: { option, id }, target: NoTarget });
    }
    return new Set(selected);
  };
  const services = matches(
    options["include-services"],
    api.services.map((s) => s.id),
    "include-services",
  );
  const operations = matches(
    options["include-operations"],
    api.services.flatMap((s) => s.groups.flatMap((g) => g.operations.map((o) => o.id))),
    "include-operations",
  );
  const roots = matches(
    options["include-types"],
    [...api.types, ...api.customScalars].map((t) => t.id),
    "include-types",
  );
  const selected = api.services
    .filter((s) => !services || services.has(s.id))
    .map((s) => ({
      ...s,
      groups: s.groups
        .map((g) => ({ ...g, operations: g.operations.filter((o) => !operations || operations.has(o.id)) }))
        .filter((g) => !operations || g.operations.length > 0),
    }));
  if (options["model-collection"] !== "reachable") return { ...api, services: selected };
  const { retained, scalars } = reachableTypes(api.types, selected, roots ?? new Set());
  return {
    ...api,
    services: selected,
    types: api.types.filter((t) => retained.has(t.id)),
    customScalars: api.customScalars.filter((s) => scalars.has(s.id) || roots?.has(s.id)),
  };
}

/** Walk wire references, base classes and discriminator mappings, including recursive models. */
function reachableTypes(types: TypeIR[], services: ApiIR["services"], roots: Set<string>): { retained: Set<string>; scalars: Set<string> } {
  const byId = new Map(types.map((type) => [type.id, type]));
  const retained = new Set<string>();
  const scalars = new Set<string>();
  const include = (id: string): void => {
    if (retained.has(id)) return;
    const type = byId.get(id);
    if (!type) return;
    retained.add(id);
    visit(type);
    if (type.kind === "model") {
      if (type.baseId) include(type.baseId);
      for (const variant of Object.values(type.discriminator?.mapping ?? {})) include(variant);
    }
  };
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.kind === "scalar" && record.custom) scalars.add((record.custom as { id: string }).id);
    if (record.kind === "named" && typeof record.id === "string") include(record.id);
    for (const [key, child] of Object.entries(record)) {
      if (key !== "decorators" && key !== "namespaceDecorators") visit(child);
    }
  };
  visit(services);
  roots.forEach(include);
  return { retained, scalars };
}
