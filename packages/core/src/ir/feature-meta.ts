import { getNamespaceFullName, NoTarget, type Namespace, type Program } from "@typespec/compiler";
import { isRecord, overrideAllowed, type FeatureNodeKind, type ResolvedFeatures } from "../features.js";
import { reportDiagnostic } from "../lib.js";
import { mergeScopes, metaScopes, resolveMeta, type MetaScopes } from "../meta.js";
import { collectDecorators } from "./decorators.js";
import type { ApiIR, DecoratorData } from "./types.js";

/** `@meta` scopes of a declaration including its enclosing namespaces (outermost first, the declaration last). */
export function declarationScopes(own: DecoratorData, namespaces: readonly DecoratorData[] = []): MetaScopes {
  return [...namespaces, own].map(metaScopes).reduce<MetaScopes>((acc, scopes) => mergeScopes(acc, scopes), {});
}

function walkNamespaces(ns: Namespace, visit: (ns: Namespace) => void): void {
  for (const child of ns.namespaces.values()) {
    if (ns.name === "" && child.name === "TypeSpec") continue;
    visit(child);
    walkNamespaces(child, visit);
  }
}

/**
 * Reports `invalid-meta` for `features` in `@meta` (the `"*"` and `language` scopes) of every namespace, type,
 * interface and operation: a non-object `features`, a non-boolean value, an override the feature does not allow
 * there, or (language scope only; `"*"` may hold other languages' features) an unknown key. Each key is reported
 * once per declaration.
 *
 * The `language:target` scope (see `meta.ts`) is not validated here, and invalid values under it are silently
 * ignored rather than reported: `ResolvedFeatures.at(key, meta, kind)` takes no target, so a `language:target`
 * scope's features are never applied to docs or generics either. `stripDocs` and the `generics` callback
 * (`buildFeaturedApiIR` in `pipeline/run-features.ts`) resolve `@meta` without a target — the ApiIR they operate on
 * is built once and shared across every target — so a `language:target` scope's `features.docs`/`features.generics`
 * has no effect there. Only a target that resolves its own `@meta` (with its name as the target) and calls
 * `ctx.features.at()` (`TargetContext.features`, per-target-merged) itself sees a `language:target` scope's values.
 */
export function checkMetaFeatures(program: Program, api: ApiIR, features: ResolvedFeatures<string>, language: string): void {
  const reported = new Set<string>();
  const known = Object.keys(features.defs).sort().join(", ");
  const check = (decorators: DecoratorData, where: string, kind: FeatureNodeKind): void => {
    const scopes = metaScopes(decorators);
    const report = (key: string, expected: string): void => {
      const id = `${where}\0${key}`;
      if (reported.has(id)) return;
      reported.add(id);
      reportDiagnostic(program, { code: "invalid-meta", format: { key, where, expected }, target: NoTarget });
    };
    for (const scope of ["*", language]) {
      const raw = scopes[scope]?.features;
      if (raw === undefined) continue;
      if (!isRecord(raw)) {
        report("features", "an object");
        continue;
      }
      for (const [key, value] of Object.entries(raw)) {
        const def = features.defs[key];
        if (def === undefined) {
          if (scope === language) report(`features.${key}`, `a known feature (${known})`);
        } else if (typeof value !== "boolean") {
          report(`features.${key}`, "a boolean");
        } else if (!def.override) {
          report(`features.${key}`, "set in tspconfig (this feature has no @meta override)");
        } else if (!overrideAllowed(def, kind)) {
          const expected =
            def.override === "model" ? "set on a namespace or model" : "set on a namespace, interface or operation";
          report(`features.${key}`, expected);
        }
      }
    }
  };
  walkNamespaces(program.getGlobalNamespaceType(), (ns) => check(collectDecorators(ns), getNamespaceFullName(ns), "namespace"));
  for (const type of api.types) check(type.decorators, type.id, type.kind);
  for (const scalar of api.customScalars) check(scalar.decorators, scalar.id, "scalar");
  // An operation declared directly in a namespace (no interface) gets a group whose `id`/`decorators` are that
  // namespace's own (see `buildService` in `ir/services.ts`, `OperationGroupIR.container`): that namespace was
  // already checked as "namespace" above, while walking every namespace in the program. Checking it again here as
  // "interface" would be wrong, not just redundant: an override level like "model" allows a namespace but not an
  // interface, so a namespace-container group would wrongly get `invalid-meta` for an override that is honoured.
  for (const service of api.services) {
    for (const group of service.groups) {
      if (group.container === "interface") check(group.decorators, group.id, "interface");
      for (const op of group.operations) check(op.decorators, op.id, "operation");
    }
  }
}

/**
 * Deletes `docs` (from `@doc` / doc comments) from IR nodes whose `features.docs` resolves false for `language`:
 * types with their properties, enum members, union variants and events; custom scalars; interfaces; operations
 * with their parameters, body and parts. Service docs follow the global value.
 *
 * A custom scalar's own `@meta` and its enclosing namespaces' both apply (`declarationScopes`, kind `"scalar"`),
 * same as a model/enum/union: every `TypeRef.custom` pointing at a given scalar is the very same object
 * (`TypeCollector`'s per-`Scalar` cache), so stripping it once here — from `api.customScalars`, not by walking
 * every ref — turns its docs off everywhere it is used.
 *
 * Known limitation: an anonymous inline model or union (`TypeIR.id` starting with `"$anon."`, e.g. an operation's
 * inline request/response body, or a property's inline object type) only inherits `docs` from the namespaces
 * enclosing it (`namespaceDecoratorsField`, unaffected by this gap). A `@meta` override set directly on the model,
 * interface or operation that declares the anonymous type (not on one of the namespaces enclosing it) has no
 * effect on the anonymous type's own `docs`, because nothing in the IR records which declaration owns it. Closing
 * this would need the collector to stamp an anonymous type with its owner's scopes (or an `owner` id) at collection
 * time; until then, an inline body/property type's docs are only reliably gated by a namespace-level override.
 */
export function stripDocs(api: ApiIR, features: ResolvedFeatures<string>, language: string): void {
  const on = (scopes: MetaScopes, kind: FeatureNodeKind) => features.at("docs", resolveMeta(scopes, language), kind);
  for (const type of api.types) {
    if (on(declarationScopes(type.decorators, type.namespaceDecorators), type.kind)) continue;
    delete type.docs;
    if (type.kind === "model") type.properties.forEach((p) => delete p.docs);
    if (type.kind === "enum") type.members.forEach((m) => delete m.docs);
    if (type.kind === "union") {
      type.variants.forEach((v) => delete v.docs);
      type.events?.forEach((e) => delete e.docs);
    }
  }
  for (const scalar of api.customScalars) {
    if (!on(declarationScopes(scalar.decorators, scalar.namespaceDecorators), "scalar")) delete scalar.docs;
  }
  for (const service of api.services) {
    if (!features.values.docs) delete service.docs;
    for (const group of service.groups) {
      const groupScopes = declarationScopes(group.decorators, group.namespaceDecorators);
      if (!on(groupScopes, group.container)) delete group.docs;
      for (const op of group.operations) {
        if (on(mergeScopes(groupScopes, metaScopes(op.decorators)), "operation")) continue;
        delete op.docs;
        op.params.forEach((p) => delete p.docs);
        if (op.body) {
          delete op.body.docs;
          op.body.parts?.forEach((p) => delete p.docs);
        }
      }
    }
  }
}
