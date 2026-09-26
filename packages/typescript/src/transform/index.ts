import type { ApiIR } from "@tspgen/emitter-core";
import type { Program } from "@typespec/compiler";
import { DeclarationBuilder } from "./declarations.js";
import type { TsIR } from "./model.js";
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
  const builder = new DeclarationBuilder(program, api, { layout });
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
    api,
  };
}
