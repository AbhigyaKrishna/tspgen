import { metaStrings, type FileSpec } from "@abhigyakrishna/tspgen-core";
import type { Program } from "@typespec/compiler";
import { camel, codecImports, organizeImports, serializerExpr, serializerImports, type KotlinIR, type KtGroup } from "@abhigyakrishna/tspgen-kotlin";
import { serviceAuth, type ServiceAuth } from "./auth.js";
import type { KtorClientOptions } from "./options.js";
import { clientJsonExpr, DEFAULT_CLIENT_RUNTIME, type ClientRuntime } from "./runtime.js";
import { hasBracketQuery, multipartResponseImports, serializerCallImports, usesSerializers } from "./helpers.js";
import { eventFunctions, responseStreams, streamsOf, supportImports, usesJson } from "./sse.js";
import { webSocketOperation } from "./websocket.js";

const SUPPORT_IMPORTS = [
  "io.ktor.client.statement.HttpResponse",
  "io.ktor.client.statement.bodyAsText",
  "io.ktor.http.ContentType",
  "io.ktor.http.contentType",
  "kotlinx.serialization.json.Json",
  "kotlinx.serialization.json.JsonPrimitive",
  "kotlinx.serialization.json.contentOrNull",
  "kotlinx.serialization.json.decodeFromJsonElement",
  "kotlinx.serialization.json.encodeToJsonElement",
  "kotlinx.serialization.json.jsonObject",
  "kotlinx.serialization.json.jsonPrimitive",
];

const API_CLIENT_IMPORTS = [
  "io.ktor.client.HttpClient",
  "io.ktor.client.HttpClientConfig",
  "io.ktor.client.plugins.contentnegotiation.ContentNegotiation",
  "io.ktor.serialization.kotlinx.json.json",
  "kotlinx.serialization.json.Json",
];

function groupImports(ir: KotlinIR, group: KtGroup, runtime: ClientRuntime, webSockets: Set<string>): string[] {
  const ops = group.operations;
  const jsonLines = ops.some((operation) => operation.body?.jsonLines || responseStreams(operation).some(stream => stream.protocol === "jsonl"));
  const httpOperations = ops.filter((op) => !webSockets.has(op.id));
  const rawStreams = runtime.streaming && ops.some((op) => op.result.kind === "single" && op.result.type.text === "ByteArray");
  const scopedStreams = rawStreams || ops.some((op) => responseStreams(op).length > 0);
  const bounded = (runtime.maxResponseSize ?? 0) > 0 || (runtime.maxErrorSize ?? 0) > 0;
  return [
    ...ops.flatMap(multipartResponseImports),
    ...ops.flatMap(operation => responseStreams(operation).flatMap(stream => stream.type.imports)),
    ...(ops.some((op) => op.responses.some((response) => response.body?.multipart)) ? ir.serializers.map((fqn) => `${ir.modelsPackage}.${fqn.slice(fqn.lastIndexOf(".") + 1)}Serializer`) : []),
    ...(bounded ? ops.flatMap((op) => op.responses.flatMap((response) => response.body?.imports ?? [])) : []),
    ...(scopedStreams ? ["io.ktor.client.request.prepareRequest", "io.ktor.client.statement.bodyAsChannel"] : []),
    ...(rawStreams ? ["io.ktor.utils.io.ByteReadChannel"] : []),
    "io.ktor.client.HttpClient",
    ...(ir.modelCheckException && ops.some((operation) => operation.params.some((parameter) => parameter.checks?.length) || operation.body?.checks?.length) ? [ir.modelCheckException] : []),
    ...(jsonLines ? [
      "kotlinx.serialization.builtins.serializer", "kotlinx.serialization.builtins.nullable",
      "kotlinx.serialization.builtins.ListSerializer", "kotlinx.serialization.builtins.MapSerializer",
      ...ir.serializers.map((fqn) => `${ir.modelsPackage}.${fqn.slice(fqn.lastIndexOf(".") + 1)}Serializer`),
      ...ops.flatMap((operation) => [operation.body?.jsonLines, ...responseStreams(operation).filter(stream => stream.protocol === "jsonl").map(stream => stream.type)].flatMap((type) => type ? serializerImports(type) : [])),
    ] : []),
    ...(ops.some((operation) => operation.responses.some((response) => response.body?.file)) ? ["io.ktor.http.contentType"] : []),
    ...(ops.some(hasBracketQuery) ? ["io.ktor.http.encodeURLParameter"] : []),
    ...(httpOperations.length > 0 ? ["io.ktor.client.call.body", "io.ktor.http.HttpMethod", `${ir.apiPackage}.ApiException`] : []),
    ...(scopedStreams ? ["io.ktor.client.plugins.expectSuccess", "io.ktor.http.appendPathSegments", "io.ktor.http.takeFrom"] : []),
    ...(httpOperations.some((o) => o.result.kind === "single") ? ["io.ktor.http.isSuccess"] : []),
    ...(ops.some((o) => o.params.some((p) => p.location === "header") || o.body?.kind === "file" || responseStreams(o).length > 0)
      ? ["io.ktor.client.request.header"]
      : []),
    ...(ops.some((o) => responseStreams(o).length > 0)
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
      ...serializerCallImports(o),
      ...o.params.flatMap((p) => codecImports(p.type)),
      ...(o.body?.type.imports ?? []),
      ...o.result.type.imports,
      ...o.errors.flatMap((e) => e.exception.imports),
      // Response headers are decoded inline (`headerExpr`): a value-class/typealias scalar's decode expression
      // names its underlying type directly (`Seen(Instant.parse(it))`), which needs that import too.
      ...o.responses.flatMap((r) => r.headers.flatMap((h) => codecImports(h.type))),
    ]),
  ];
}

export function planClientFiles(
  ir: KotlinIR,
  options: KtorClientOptions,
  program: Program,
  runtime: ClientRuntime = DEFAULT_CLIENT_RUNTIME,
): FileSpec[] {
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
  const streams = streamsOf(services.flatMap((s) => s.groups.flatMap((g) => g.operations)));
  const allOps = services.flatMap((s) => s.groups.flatMap((g) => g.operations));
  const multipartResponses = allOps.some((operation) => operation.responses.some((response) => response.body?.multipart));
  const jsonLines = allOps.some((operation) => operation.body?.jsonLines || responseStreams(operation).some(stream => stream.protocol === "jsonl"));
  const webSockets = new Set(allOps.filter(webSocketOperation).map((op) => op.id));
  // Bodies (and parts) whose JSON form needs an explicit serializer (`@encode(string)` values).
  const bounded = (runtime.maxResponseSize ?? 0) > 0 || (runtime.maxErrorSize ?? 0) > 0;
  const serializers = allOps.some(usesSerializers);
  const jsonPartSerializers = multipartBodies.some((b) => (b.parts ?? []).some((p) => p.kind === "json" && serializerExpr(p.type)));
  // Multipart JSON parts, JSON events and explicitly serialized bodies read the defaults' Json from the client (apiJson).
  const apiJson = bounded || multipart || multipartResponses || jsonLines || streams.events.some(usesJson) || serializers;
  const auths = new Map<string, ServiceAuth | undefined>(services.map((s) => [s.id, runtime.auth ? serviceAuth(program, s) : undefined]));
  const used = [...auths.values()].filter((a): a is ServiceAuth => a !== undefined);
  const basic = used.some((a) => a.basic);
  const files: FileSpec[] = [
    {
      path: `${dir}/ClientSupport.kt`,
      template: "kotlin/file",
      data: {
        package: pkg,
        imports: organizeImports(
          [
            ...SUPPORT_IMPORTS,
            ...(multipartResponses ? ["io.ktor.client.call.body", "io.ktor.http.content.forEachPart", "io.ktor.utils.io.toByteArray"] : []),
            ...(jsonLines ? [
              "io.ktor.utils.io.ByteReadChannel", "io.ktor.utils.io.readLine", "io.ktor.utils.io.writeStringUtf8",
              "kotlinx.coroutines.flow.Flow", "kotlinx.coroutines.flow.collect", "kotlinx.serialization.KSerializer",
            ] : []),
            ...(webSockets.size > 0
              ? [
                  "io.ktor.client.plugins.websocket.DefaultClientWebSocketSession",
                  "io.ktor.client.plugins.websocket.webSocket",
                  "io.ktor.http.URLProtocol",
                ]
              : []),
            "io.ktor.client.HttpClient",
            "io.ktor.client.request.HttpRequestBuilder",
            "io.ktor.client.request.prepareRequest",
            "io.ktor.client.plugins.expectSuccess",
            "io.ktor.http.HttpMethod",
            "io.ktor.http.appendPathSegments",
            "io.ktor.http.takeFrom",
            ...(bounded
              ? [
                  "io.ktor.client.statement.bodyAsChannel",
                  "io.ktor.client.call.body",
                  "io.ktor.http.isSuccess",
                  "io.ktor.utils.io.readRemaining",
                  "kotlinx.io.readByteArray",
                  "kotlinx.io.Buffer",
                  "io.ktor.http.charset",
                  "io.ktor.utils.io.charsets.Charsets",
                  "io.ktor.utils.io.charsets.decode",
                  `${ir.apiPackage}.ApiException`,
                ]
              : []),
            ...(multipart ? ["io.ktor.http.Headers", "io.ktor.http.HttpHeaders", "io.ktor.http.headersOf"] : []),
            ...(fileParts ? [`${ir.modelsPackage}.HttpFile`, "io.ktor.http.ContentDisposition", "io.ktor.http.quote"] : []),
            ...supportImports(streams),
            ...(apiJson
              ? [
                  "io.ktor.client.HttpClient",
                  "io.ktor.client.plugins.api.ClientPlugin",
                  "io.ktor.client.plugins.api.createClientPlugin",
                  "io.ktor.util.AttributeKey",
                ]
              : []),
            ...(used.length > 0
              ? ["io.ktor.client.request.HttpRequestBuilder", "io.ktor.client.request.cookie", "io.ktor.http.HttpHeaders"]
              : []),
            ...(basic ? ["io.ktor.util.encodeBase64"] : []),
            ...(jsonPartSerializers ? ["kotlinx.serialization.KSerializer"] : []),
          ],
          pkg,
        ),
        body: "ktor-client/support",
        jsonLines,
        webSockets: webSockets.size > 0,
        multipart,
        multipartResponses,
        bounded,
        maxResponseSize: runtime.maxResponseSize ?? 0,
        maxErrorSize: runtime.maxErrorSize ?? 0,
        jsonPartSerializers,
        fileParts,
        apiJson,
        defaultJson: `${services[0].name}Json`,
        ...(streams.any
          ? {
              sse: {
                json: streams.events.some(usesJson),
                functions: streams.events.flatMap(eventFunctions),
                maxSize: runtime.sseMaxSize,
              },
            }
          : {}),
        ...(used.length > 0 ? { auth: { basic } } : {}),
      },
    },
  ];
  for (const service of services) {
    const auth = auths.get(service.id);
    for (const group of service.groups) {
      const extras = Object.fromEntries(
        group.operations.map((op) => [
          op.id,
          {
            annotations: metaStrings(program, op.meta["kotlin:ktor-client"] ?? {}, "annotations", op.id),
            webSocket: webSockets.has(op.id),
            streamName: `${op.name.replaceAll("`", "")}Stream`,
            ...(auth ? { auth: auth.op(op, `${group.name}Client`) } : {}),
          },
        ]),
      );
      const takenMethods = new Set(group.operations.map((op) => op.name.replaceAll("`", "")));
      for (const extra of Object.values(extras)) {
        const preferred = extra.streamName;
        for (let suffix = 2; takenMethods.has(extra.streamName); suffix++) extra.streamName = `${preferred}${suffix}`;
        takenMethods.add(extra.streamName);
      }
      const authPlans: { name: string; alternatives: string }[] = [];
      for (const extra of Object.values(extras)) {
        if (!extra.auth) continue;
        const alternatives = extra.auth.alternatives;
        let plan = authPlans.find((p) => p.alternatives === alternatives);
        if (!plan) {
          plan = {
            name: `authPlan${authPlans.length + 1}`,
            alternatives,
          };
          authPlans.push(plan);
        }
        extra.auth.alternatives = `this@${group.name}Client.${plan.name}`;
      }
      files.push({
        path: `${dir}/${group.name}Client.kt`,
        template: "kotlin/file",
        data: {
          package: pkg,
          imports: organizeImports(groupImports(ir, group, runtime, webSockets), pkg),
          body: "ktor-client/client",
          group,
          extras,
          authPlans,
          bounded,
          streaming: runtime.streaming,
          auth: auth?.className,
        },
      });
    }
    files.push({
      path: `${dir}/${service.name}ApiClient.kt`,
      template: "kotlin/file",
      data: {
        package: pkg,
        imports: organizeImports(
          [
            ...API_CLIENT_IMPORTS,
            ...(service.groups.some((group) => group.operations.some((op) => webSockets.has(op.id)))
              ? ["io.ktor.client.plugins.websocket.WebSockets", "io.ktor.serialization.kotlinx.KotlinxWebsocketSerializationConverter"]
              : []),
            ...(ir.serializersModule ? [ir.serializersModule] : []),
          ],
          pkg,
        ),
        body: "ktor-client/api-client",
        webSockets: service.groups.some((group) => group.operations.some((op) => webSockets.has(op.id))),
        json: clientJsonExpr(ir, runtime),
        jsonName: `${service.name}Json`,
        apiJson,
        auth,
        service,
        clientName: `${service.name}ApiClient`,
        defaultsFn: `${camel(service.name)}Defaults`,
      },
    });
  }
  return files;
}
