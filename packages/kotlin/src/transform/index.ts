import type { ApiIR } from "@specgen/emitter-core";
import type { Program } from "@typespec/compiler";
import type { EnumMemberNaming } from "../lib.js";
import { DeclarationBuilder } from "./declarations.js";
import type { KotlinIR } from "./model.js";
import { ApiBuilder } from "./operations.js";

export * from "./model.js";

export interface KotlinTransformOptions {
  package: string;
  enumMemberNaming: EnumMemberNaming;
}

export function resolveKotlinOptions(options: Record<string, unknown>): KotlinTransformOptions {
  const naming = options.naming as { "enum-members"?: EnumMemberNaming } | undefined;
  return {
    package: typeof options.package === "string" ? options.package : "generated",
    enumMemberNaming: naming?.["enum-members"] ?? "UPPER_SNAKE",
  };
}

export function transformToKotlin(program: Program, api: ApiIR, options: KotlinTransformOptions): KotlinIR {
  const modelsPackage = `${options.package}.models`;
  const apiPackage = `${options.package}.api`;
  const builder = new DeclarationBuilder(program, api, { modelsPackage, enumMemberNaming: options.enumMemberNaming });
  const declarations = builder.build();
  const apiBuilder = new ApiBuilder(builder, apiPackage);
  const services = apiBuilder.services(api, options.package);
  return {
    basePackage: options.package,
    modelsPackage,
    apiPackage,
    declarations,
    apiDeclarations: apiBuilder.declarations(),
    services,
    api,
  };
}
