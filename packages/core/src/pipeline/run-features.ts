import type { Model, Program } from "@typespec/compiler";
import { defaultHeaderText } from "../comments.js";
import { coreFeatures, defineFeatures, emitterFeatures, type ResolvedFeatures } from "../features.js";
import { buildApiIR } from "../ir/build.js";
import { collectDecorators, enclosingNamespaceDecorators } from "../ir/decorators.js";
import { checkMetaFeatures, declarationScopes, stripDocs } from "../ir/feature-meta.js";
import type { SseLibraries } from "../ir/sse.js";
import type { ApiIR } from "../ir/types.js";
import type { ResolvedService } from "../ir/versioning.js";
import { resolveMeta } from "../meta.js";
import type { TspGenPlugin } from "../plugins/plugin.js";
import type { LanguageModule } from "../targets/target.js";

/**
 * Resolves core, language and plugin features against `emitterOptions.features`; undefined after `emitterFeatures`
 * reports `duplicate-feature`/`unknown-feature`.
 */
export function resolveRunFeatures<L>(
  program: Program,
  language: LanguageModule<L>,
  plugins: readonly TspGenPlugin<L>[],
  configured: unknown,
): ResolvedFeatures<string> | undefined {
  return emitterFeatures(
    program,
    language.emitter ?? language.name,
    defineFeatures({ ...coreFeatures, ...language.features?.defs }),
    plugins,
    configured,
  );
}

/**
 * Builds the ApiIR deciding `generics` per template declaration from `features`, validates `@meta` feature
 * overrides over it (`checkMetaFeatures`), and strips `docs` where `features.docs` resolves false (`stripDocs`).
 */
export function buildFeaturedApiIR(
  program: Program,
  features: ResolvedFeatures<string>,
  language: string,
  services: ResolvedService[],
  sse?: SseLibraries,
): ApiIR {
  const api = buildApiIR(program, {
    generics: (declaration: Model) =>
      features.at(
        "generics",
        resolveMeta(declarationScopes(collectDecorators(declaration), enclosingNamespaceDecorators(declaration)), language),
        "model",
      ),
    services,
    ...(sse ? { sse } : {}),
  });
  checkMetaFeatures(program, api, features, language);
  stripDocs(api, features, language);
  return api;
}

/**
 * The header banner text for every rendered file: "" when `features.header` is false; the `header-text` option
 * (a blank or whitespace-only string counts as unset — `features.header: false` is how a banner is removed) when
 * set; the emitter's default (`defaultHeaderText`) otherwise.
 */
export function resolveHeaderText(
  features: ResolvedFeatures<string>,
  options: Record<string, unknown>,
  emitter: string,
): string {
  if (features.values.header === false) return "";
  const text = options["header-text"];
  return typeof text === "string" && text.trim() !== "" ? text : defaultHeaderText(emitter);
}
