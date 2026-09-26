import { metaStrings, type FileSpec } from "@specgen/emitter-core";
import type { Program } from "@typespec/compiler";
import { camel, organizeImports, type KotlinIR, type KtGroup } from "@specgen/emitter-kotlin";
import type { KtorClientOptions } from "./options.js";

const SUPPORT_IMPORTS = [
  "kotlinx.serialization.json.Json",
  "kotlinx.serialization.json.JsonPrimitive",
  "kotlinx.serialization.json.decodeFromJsonElement",
  "kotlinx.serialization.json.encodeToJsonElement",
];

const API_CLIENT_IMPORTS = [
  "io.ktor.client.HttpClient",
  "io.ktor.client.HttpClientConfig",
  "io.ktor.client.plugins.contentnegotiation.ContentNegotiation",
  "io.ktor.serialization.kotlinx.json.json",
  "kotlinx.serialization.json.Json",
];

function groupImports(ir: KotlinIR, group: KtGroup): string[] {
  const ops = group.operations;
  return [
    "io.ktor.client.HttpClient",
    "io.ktor.client.call.body",
    "io.ktor.client.request.request",
    "io.ktor.client.statement.bodyAsText",
    "io.ktor.http.HttpMethod",
    "io.ktor.http.appendPathSegments",
    "io.ktor.http.takeFrom",
    `${ir.apiPackage}.ApiException`,
    ...(ops.some((o) => o.result.kind === "single") ? ["io.ktor.http.isSuccess"] : []),
    ...(ops.some((o) => o.params.some((p) => p.location === "header")) ? ["io.ktor.client.request.header"] : []),
    ...(ops.some((o) => o.params.some((p) => p.location === "cookie")) ? ["io.ktor.client.request.cookie"] : []),
    ...(ops.some((o) => o.body)
      ? ["io.ktor.client.request.setBody", "io.ktor.http.ContentType", "io.ktor.http.contentType"]
      : []),
    ...ops.flatMap((o) => [
      ...o.params.flatMap((p) => p.type.imports),
      ...(o.body?.type.imports ?? []),
      ...o.result.type.imports,
      ...o.errors.flatMap((e) => e.exception.imports),
    ]),
  ];
}

export function planClientFiles(ir: KotlinIR, options: KtorClientOptions, program: Program): FileSpec[] {
  const services = ir.services.filter((s) => s.groups.length > 0);
  if (services.length === 0) return [];
  const pkg = options.package ?? `${ir.basePackage}.client`;
  const dir = `client/${pkg.replaceAll(".", "/")}`;
  const files: FileSpec[] = [
    {
      path: `${dir}/ClientSupport.kt`,
      template: "kotlin/file",
      data: { package: pkg, imports: SUPPORT_IMPORTS, body: "ktor-client/support" },
    },
  ];
  for (const service of services) {
    for (const group of service.groups) {
      const extras = Object.fromEntries(
        group.operations.map((op) => [
          op.id,
          { annotations: metaStrings(program, op.meta["kotlin:ktor-client"] ?? {}, "annotations", op.id) },
        ]),
      );
      files.push({
        path: `${dir}/${group.name}Client.kt`,
        template: "kotlin/file",
        data: { package: pkg, imports: organizeImports(groupImports(ir, group), pkg), body: "ktor-client/client", group, extras },
      });
    }
    files.push({
      path: `${dir}/${service.name}ApiClient.kt`,
      template: "kotlin/file",
      data: {
        package: pkg,
        imports: API_CLIENT_IMPORTS,
        body: "ktor-client/api-client",
        service,
        clientName: `${service.name}ApiClient`,
        defaultsFn: `${camel(service.name)}Defaults`,
      },
    });
  }
  return files;
}
