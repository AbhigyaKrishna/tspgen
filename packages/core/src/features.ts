import { NoTarget, type Program } from "@typespec/compiler";
import { reportDiagnostic } from "./lib.js";
import type { MetaData } from "./meta.js";

/**
 * Where a feature may be overridden with `@meta(scope, #{ features: #{ <key>: bool } })`: `false` nowhere (tspconfig
 * only); `"declaration"` on namespaces, interfaces, operations, models, enums and unions; `"operation"` on
 * namespaces, interfaces and operations; `"model"` on namespaces and models only (namespaces carry the default
 * down to the models they enclose; an enum, union, interface or operation may not override it).
 */
export type FeatureOverride = false | "declaration" | "operation" | "model";

/** The kind of declaration a feature value is asked for (see `ResolvedFeatures.at`). */
export type FeatureNodeKind = "namespace" | "interface" | "operation" | "model" | "enum" | "union" | "scalar";

export interface FeatureDef {
  default: boolean;
  description: string;
  /** Default `false`. */
  override?: FeatureOverride;
}

export interface ResolvedFeatures<K extends string = string> {
  defs: Readonly<Record<K, FeatureDef>>;
  /** Definition defaults, overridden by booleans set in tspconfig. */
  values: Readonly<Record<K, boolean>>;
  /** Keys set in tspconfig (for `unsupported-feature` warnings). */
  explicit: ReadonlySet<K>;
  /**
   * Value for one declaration: a boolean `features.<key>` in its resolved `@meta` when the feature allows an
   * override on `kind`, else `values[key]`. Invalid overrides are reported by `checkMetaFeatures`, not here.
   * `false` for a `key` this set does not define (`values[key] ?? false`).
   */
  at(key: K, meta: MetaData, kind: FeatureNodeKind): boolean;
}

export interface FeatureSet<K extends string = string> {
  defs: Readonly<Record<K, FeatureDef>>;
  /** JSON schema of a target's `features` option: closed, defaults applied by `loadTargets`. */
  schema: object;
  /** JSON schema of a language emitter's `features` option: open, because plugins may add features. */
  openSchema: object;
  resolve(configured: unknown): ResolvedFeatures<K>;
}

const TYPE_KINDS: ReadonlySet<FeatureNodeKind> = new Set(["model", "enum", "union", "scalar"]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `def` may be overridden with `@meta` on a declaration of `kind`. */
export function overrideAllowed(def: FeatureDef, kind: FeatureNodeKind): boolean {
  switch (def.override) {
    case "declaration":
      return true;
    case "operation":
      return !TYPE_KINDS.has(kind);
    case "model":
      return kind === "model" || kind === "namespace";
    default:
      return false;
  }
}

function resolvedFeatures<K extends string>(
  defs: Readonly<Record<K, FeatureDef>>,
  values: Readonly<Record<K, boolean>>,
  explicit: ReadonlySet<K>,
): ResolvedFeatures<K> {
  return {
    defs,
    values,
    explicit,
    at(key, meta, kind) {
      const def = defs[key];
      const override = isRecord(meta.features) ? meta.features[key] : undefined;
      if (def !== undefined && typeof override === "boolean" && overrideAllowed(def, kind)) return override;
      return values[key] ?? false;
    },
  };
}

function booleanProperties(defs: Readonly<Record<string, FeatureDef>>): Record<string, object> {
  return Object.fromEntries(
    Object.entries(defs).map(([key, def]) => [key, { type: "boolean", default: def.default, description: def.description }]),
  );
}

export function defineFeatures<K extends string>(defs: Readonly<Record<K, FeatureDef>>): FeatureSet<K> {
  const properties = booleanProperties(defs);
  return {
    defs,
    schema: { type: "object", additionalProperties: false, default: {}, properties },
    openSchema: {
      type: "object",
      nullable: true,
      additionalProperties: true,
      properties: { ...properties },
      description: "On/off gates (see the README's Options reference); plugins may add their own.",
    },
    resolve(configured) {
      const values = {} as Record<K, boolean>;
      const explicit = new Set<K>();
      for (const key of Object.keys(defs) as K[]) {
        const value = isRecord(configured) ? configured[key] : undefined;
        if (typeof value === "boolean") {
          values[key] = value;
          explicit.add(key);
        } else {
          values[key] = defs[key].default;
        }
      }
      return resolvedFeatures(defs, values, explicit);
    },
  };
}

/** `base` plus `over`; `over`'s keys win (definition, value and explicit flag). */
export function mergeFeatures<A extends string, B extends string>(
  base: ResolvedFeatures<A>,
  over: ResolvedFeatures<B>,
): ResolvedFeatures<A | B> {
  const own = new Set<string>(Object.keys(over.defs));
  return resolvedFeatures<A | B>(
    { ...base.defs, ...over.defs } as Record<A | B, FeatureDef>,
    { ...base.values, ...over.values } as Record<A | B, boolean>,
    new Set<A | B>([...[...base.explicit].filter((key) => !own.has(key)), ...over.explicit]),
  );
}

/** Features every language emitter has; spread into each language's `defineFeatures`. */
export const coreFeatures = {
  header: { default: true, description: "Banner comment at the top of every generated file (text: header-text)." },
  docs: {
    default: true,
    override: "declaration",
    description: "KDoc/JSDoc from @doc and doc comments.",
  },
  "api-version": {
    default: true,
    description: "Version constant (API_VERSION) for @versioned services; unversioned services never get one.",
  },
  generics: {
    default: true,
    override: "model",
    description: "Template models once as generic types (Page<T>); false: one model per instance (PagePet).",
  },
} as const satisfies Record<string, FeatureDef>;

/**
 * The features of one language emitter run: `base` (core + language) plus every plugin's, resolved against the
 * `features` option. Reports `duplicate-feature` (a key declared twice) and `unknown-feature` (a configured key no
 * one declares); returns undefined after reporting.
 */
export function emitterFeatures(
  program: Program,
  emitter: string,
  base: FeatureSet<string>,
  plugins: readonly { name: string; features?: Readonly<Record<string, FeatureDef>> }[],
  configured: unknown,
): ResolvedFeatures<string> | undefined {
  const defs: Record<string, FeatureDef> = { ...base.defs };
  const owners = new Map<string, string>(Object.keys(base.defs).map((key) => [key, emitter]));
  let failed = false;
  for (const plugin of plugins) {
    for (const [key, def] of Object.entries(plugin.features ?? {})) {
      const owner = `plugin '${plugin.name}'`;
      const first = owners.get(key);
      if (first !== undefined) {
        reportDiagnostic(program, { code: "duplicate-feature", format: { key, first, second: owner }, target: NoTarget });
        failed = true;
        continue;
      }
      owners.set(key, owner);
      defs[key] = def;
    }
  }
  const unknown = isRecord(configured) ? Object.keys(configured).filter((key) => !Object.hasOwn(defs, key)) : [];
  const known = Object.keys(defs).sort().join(", ");
  for (const key of unknown) {
    reportDiagnostic(program, { code: "unknown-feature", format: { key, emitter, known }, target: NoTarget });
  }
  if (failed || unknown.length > 0) return undefined;
  return defineFeatures(defs).resolve(configured);
}

/**
 * Warns that `features.<key>` cannot be honoured in this configuration (`reason`, e.g. `layout "single-file"`),
 * but only when the user set it to true explicitly: defaults never warn.
 */
export function reportUnsupportedFeature(
  program: Program,
  features: ResolvedFeatures<string>,
  key: string,
  reason: string,
): void {
  if (!features.explicit.has(key) || features.values[key] !== true) return;
  reportDiagnostic(program, { code: "unsupported-feature", format: { key, reason }, target: NoTarget });
}
