import { metaStrings, type FileSpec } from "@abhigyakrishna/tspgen-core";
import type { Program } from "@typespec/compiler";
import { camel, codecImports, organizeImports, type KotlinIR, type KtGroup } from "@abhigyakrishna/tspgen-kotlin";
import type { KtorClientOptions } from "./options.js";
import { eventFunctions, streamOf, streamsOf, supportImports, usesJson } from "./sse.js";

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
    ...(ops.some((o) => o.params.some((p) => p.location === "header") || o.body?.kind === "file" || streamOf(o))
      ? ["io.ktor.client.request.header"]
      : []),
    ...(ops.some((o) => streamOf(o))
      ? [
          "io.ktor.client.request.prepareRequest",
          "io.ktor.client.statement.bodyAsChannel",
          "io.ktor.http.HttpHeaders",
          "kotlinx.coroutines.flow.flow",
        ]
      : []),
    ...(ops.some((o) => o.params.some((p) => p.location === "cookie")) ? ["io.ktor.client.request.cookie"] : []),
    ...(ops.some((o) => o.body) ? ["io.ktor.client.request.setBody"] : []),
    ...(ops.some((o) => o.body && o.body.kind !== "multipart") ? ["io.ktor.http.ContentType", "io.ktor.http.contentType"] : []),
    ...(ops.some((o) => o.body?.kind === "multipart")
      ? ["io.ktor.client.request.forms.MultiPartFormDataContent", "io.ktor.client.request.forms.formData"]
      : []),
    ...(ops.some((o) => o.body?.kind === "file") ? ["io.ktor.http.ContentDisposition", "io.ktor.http.HttpHeaders"] : []),
    ...ops.flatMap((o) => [
      ...o.params.flatMap((p) => p.type.imports),
      ...(o.body?.type.imports ?? []),
      ...o.result.type.imports,
      ...o.errors.flatMap((e) => e.exception.imports),
      // Response headers are decoded inline (`headerExpr`): a value-class/typealias scalar's decode expression
      // names its underlying type directly (`Seen(Instant.parse(it))`), which needs that import too.
      ...o.responses.flatMap((r) => r.headers.flatMap((h) => codecImports(h.type))),
    ]),
  ];
}

export function planClientFiles(ir: KotlinIR, options: KtorClientOptions, program: Program): FileSpec[] {
  const services = ir.services.filter((s) => s.groups.length > 0);
  if (services.length === 0) return [];
  const pkg = options.package ?? `${ir.basePackage}.client`;
  const dir = `client/${pkg.replaceAll(".", "/")}`;
  const multipartBodies = services.flatMap((s) =>
    s.groups.flatMap((g) => g.operations.flatMap((o) => (o.body?.kind === "multipart" ? [o.body] : []))),
  );
  const multipart = multipartBodies.length > 0;
  // File helpers (and HttpFile) only when some multipart body has a file part: HttpFile exists only then.
  const fileParts = multipartBodies.some((b) => (b.parts ?? []).some((p) => p.kind === "file"));
  const serializersModule = ir.serializersModule ? ir.serializersModule.slice(ir.serializersModule.lastIndexOf(".") + 1) : undefined;
  const streams = streamsOf(services.flatMap((s) => s.groups.flatMap((g) => g.operations)));
  const files: FileSpec[] = [
    {
      path: `${dir}/ClientSupport.kt`,
      template: "kotlin/file",
      data: {
        package: pkg,
        imports: organizeImports(
          [
            ...SUPPORT_IMPORTS,
            ...(multipart ? ["io.ktor.http.Headers", "io.ktor.http.HttpHeaders", "io.ktor.http.headersOf"] : []),
            ...(multipart && serializersModule ? [ir.serializersModule!] : []),
            ...(fileParts ? [`${ir.modelsPackage}.HttpFile`, "io.ktor.http.ContentDisposition", "io.ktor.http.quote"] : []),
            ...supportImports(ir, streams),
          ],
          pkg,
        ),
        body: "ktor-client/support",
        multipart,
        fileParts,
        partJson: serializersModule ? `Json { serializersModule = ${serializersModule} }` : "Json",
        ...(streams.any
          ? {
              sse: {
                json: streams.events.some(usesJson),
                functions: streams.events.flatMap(eventFunctions),
              },
            }
          : {}),
      },
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
        imports: organizeImports([...API_CLIENT_IMPORTS, ...(ir.serializersModule ? [ir.serializersModule] : [])], pkg),
        body: "ktor-client/api-client",
        json: ir.serializersModule ? `Json { serializersModule = ${ir.serializersModule.slice(ir.serializersModule.lastIndexOf(".") + 1)} }` : "Json",
        /** Event payloads decode with the defaults' format (see sseJsonPlugin in ClientSupport.kt). */
        sseJson: streams.events.some(usesJson),
        service,
        clientName: `${service.name}ApiClient`,
        defaultsFn: `${camel(service.name)}Defaults`,
      },
    });
  }
  return files;
}
