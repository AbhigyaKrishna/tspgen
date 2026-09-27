import { apiVersionConstants, type ApiIR, type ApiVersionConstant, type ResolvedFeatures } from "@abhigyakrishna/tspgen-core";
import { NoTarget, type Program } from "@typespec/compiler";
import { reportDiagnostic } from "../lib.js";
import { DeclarationBuilder } from "./declarations.js";
import type { TsDecl, TsIR } from "./model.js";
import { ApiBuilder } from "./operations.js";

export * from "./model.js";

export interface TsTransformOptions {
  zod: boolean;
  importExtension: "" | ".js";
  layout?: "per-type" | "single-file";
  errors?: "typed" | "thrown";
  /** Generate the API version constants (default true). */
  apiVersion?: boolean;
  /** Generate models/index.ts (default true). */
  barrel?: boolean;
}

export function resolveTsOptions(options: Record<string, unknown>, features?: ResolvedFeatures<string>): TsTransformOptions {
  return {
    zod: features?.values.zod === true,
    importExtension: options["import-extension"] === ".js" ? ".js" : "",
    layout: options.layout === "single-file" ? "single-file" : "per-type",
    errors: options.errors === "thrown" ? "thrown" : "typed",
    apiVersion: features?.values["api-version"] !== false,
    barrel: features?.values.barrel !== false,
  };
}

export function transformToTs(program: Program, api: ApiIR, options: TsTransformOptions): TsIR {
  const layout = options.layout ?? "per-type";
  const builder = new DeclarationBuilder(program, api, { layout, zod: options.zod });
  const declarations = builder.build();
  const apiBuilder = new ApiBuilder(builder, { errors: options.errors ?? "typed" });
  const services = apiBuilder.services(api);
  const sseMessage = builder.sseMessage;
  if (sseMessage) {
    const clash = declarations.find((d) => d.name === sseMessage.name);
    if (clash) reportDiagnostic(program, { code: "sse-message-conflict", format: { id: clash.id }, target: NoTarget });
    else declarations.push(sseMessage);
  }
  return {
    declarations,
    ...(sseMessage ? { sseMessage } : {}),
    errorClasses: apiBuilder.errors(),
    results: apiBuilder.results,
    services,
    apiActive: apiBuilder.active,
    zod: options.zod,
    importExtension: options.importExtension,
    layout,
    barrel: options.barrel !== false,
    apiVersions: options.apiVersion === false ? [] : versionConstants(program, api, declarations),
    api,
  };
}

/**
 * The version constants, without those named like a generated declaration: an `export *` that re-exports both
 * (the models barrel; the flat client's index.ts, which re-exports models/api-version instead when
 * features.barrel is false) would silently shadow the model's own export (and clash in types.ts), so the
 * clash is reported instead.
 */
function versionConstants(program: Program, api: ApiIR, declarations: TsDecl[]): ApiVersionConstant[] {
  const exported = new Map<string, TsDecl>();
  for (const d of declarations) {
    exported.set(d.name, d);
    if (d.kind === "enum" && d.values) exported.set(d.values, d);
  }
  return apiVersionConstants(api).filter((constant) => {
    const decl = exported.get(constant.name);
    if (!decl) return true;
    reportDiagnostic(program, { code: "api-version-name-clash", format: { name: constant.name, id: decl.id }, target: NoTarget });
    return false;
  });
}
