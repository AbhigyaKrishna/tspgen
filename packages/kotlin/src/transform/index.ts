import { apiVersionConstants, type ApiIR } from "@abhigyakrishna/tspgen-core";
import { NoTarget, type Program } from "@typespec/compiler";
import { reportDiagnostic, type EnumMemberNaming } from "../lib.js";
import { DeclarationBuilder } from "./declarations.js";
import type { KotlinIR, KtDecl, KtService, KtTypeUse } from "./model.js";
import { JAVA_TIME_CLASSES, javaTimeIn, type DateTimeMapping } from "./type-map.js";
import { ApiBuilder } from "./operations.js";

export * from "./model.js";
export { mappedPackage } from "./packages.js";

export interface KotlinTransformOptions {
  package: string;
  enumMemberNaming: EnumMemberNaming;
  /** TypeSpec namespace → Kotlin package (longest prefix wins). */
  packages?: Record<string, string>;
  errors?: "typed" | "thrown";
  validation?: boolean;
  dateTime?: DateTimeMapping;
  unionVariants?: "nested" | "top-level";
}

export function resolveKotlinOptions(options: Record<string, unknown>): KotlinTransformOptions {
  const naming = options.naming as { "enum-members"?: EnumMemberNaming } | undefined;
  return {
    package: typeof options.package === "string" ? options.package : "generated",
    enumMemberNaming: naming?.["enum-members"] ?? "UPPER_SNAKE",
    packages: Object.fromEntries(
      ((options.packages as { namespace: string; package: string }[] | undefined) ?? []).map((m) => [m.namespace, m.package]),
    ),
    errors: options.errors === "thrown" ? "thrown" : "typed",
    validation: options.validation === true,
    dateTime: options["date-time"] === "kotlin.time" ? "kotlin.time" : "java.time",
    unionVariants: options["union-variants"] === "top-level" ? "top-level" : "nested",
  };
}

export function transformToKotlin(program: Program, api: ApiIR, options: KotlinTransformOptions): KotlinIR {
  const modelsPackage = `${options.package}.models`;
  const apiPackage = `${options.package}.api`;
  const builder = new DeclarationBuilder(program, api, {
    modelsPackage,
    enumMemberNaming: options.enumMemberNaming,
    packages: options.packages,
    validation: options.validation,
    dateTime: options.dateTime,
    unionVariants: options.unionVariants,
  });
  const declarations = builder.build();
  const apiBuilder = new ApiBuilder(builder, apiPackage, { errors: options.errors, packages: options.packages });
  const services = apiBuilder.services(api, options.package);
  const javaTime = usedJavaTime(declarations, services);
  if (builder.fileUsed) {
    for (const d of declarations) {
      if (d.fqn === builder.httpFileFqn) {
        reportDiagnostic(program, { code: "http-file-conflict", format: { id: d.id, fqn: d.fqn }, target: NoTarget });
      }
    }
  }
  if (builder.sseMessageUsed) {
    for (const d of declarations) {
      if (d.fqn === builder.sseMessageFqn) {
        reportDiagnostic(program, { code: "sse-message-conflict", format: { id: d.id, fqn: d.fqn }, target: NoTarget });
      }
    }
  }
  return {
    basePackage: options.package,
    modelsPackage,
    apiPackage,
    declarations,
    apiDeclarations: apiBuilder.declarations(),
    services,
    api,
    javaTime,
    apiVersions: apiVersionConstants(api),
    ...(builder.fileUsed ? { httpFile: builder.httpFileFqn } : {}),
    ...(builder.sseMessageUsed ? { sseMessage: builder.sseMessageFqn } : {}),
    ...(javaTime.length > 0 ? { javaTimeModule: `${modelsPackage}.javaTimeSerializersModule` } : {}),
  };
}

function usedJavaTime(declarations: KtDecl[], services: KtService[]): string[] {
  const types: KtTypeUse[] = [];
  const addDecl = (d: KtDecl): void => {
    if (d.kind === "data-class" || d.kind === "sealed-interface") types.push(...d.properties.map((p) => p.type));
    if (d.kind === "sealed-interface") d.variants.forEach(addDecl);
    // Event payloads are encoded with the models' Json: a java.time payload needs its serializer.
    if (d.kind === "events") types.push(...d.events.flatMap((e) => (e.data ? [e.data] : [])));
  };
  declarations.forEach(addDecl);
  for (const op of services.flatMap((s) => s.groups.flatMap((g) => g.operations))) {
    types.push(...op.params.map((p) => p.type), ...(op.body ? [op.body.type] : []));
    for (const r of op.responses) types.push(...(r.body ? [r.body] : []), ...r.headers.map((h) => h.type));
  }
  const used = new Set(types.flatMap(javaTimeIn));
  return JAVA_TIME_CLASSES.filter((fqn) => used.has(fqn));
}
