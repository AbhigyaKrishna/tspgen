import { apiVersionConstants, type ApiIR, type ApiVersionConstant } from "@abhigyakrishna/tspgen-core";
import { NoTarget } from "@typespec/compiler";
import { reportDiagnostic } from "../lib.js";
import type { Program } from "@typespec/compiler";
import { DeclarationBuilder } from "./declarations.js";
import type { TsDecl, TsIR } from "./model.js";
import { ApiBuilder } from "./operations.js";

export * from "./model.js";

export interface TsTransformOptions {
  zod: boolean;
  importExtension: "" | ".js";
  layout?: "per-type" | "single-file";
  errors?: "typed" | "thrown";
}

export function resolveTsOptions(options: Record<string, unknown>): TsTransformOptions {
  return {
    zod: options.zod === true,
    importExtension: options["import-extension"] === ".js" ? ".js" : "",
    layout: options.layout === "single-file" ? "single-file" : "per-type",
    errors: options.errors === "thrown" ? "thrown" : "typed",
  };
}

export function transformToTs(program: Program, api: ApiIR, options: TsTransformOptions): TsIR {
  const layout = options.layout ?? "per-type";
  const builder = new DeclarationBuilder(program, api, { layout, zod: options.zod });
  const declarations = builder.build();
  const apiBuilder = new ApiBuilder(builder, { errors: options.errors ?? "typed" });
  const services = apiBuilder.services(api);
  return {
    declarations,
    errorClasses: apiBuilder.errors(),
    results: apiBuilder.results,
    services,
    apiActive: apiBuilder.active,
    zod: options.zod,
    importExtension: options.importExtension,
    layout,
    apiVersions: versionConstants(program, api, declarations),
    api,
  };
}

/**
 * The version constants, without those named like a generated declaration: the barrel's own export would
 * silently shadow the model's `export *` (and clash in types.ts), so the clash is reported instead.
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
