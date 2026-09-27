import { reportDiagnostic } from "@abhigyakrishna/tspgen-core";
import {
  kotlinString as str,
  serializerExpr,
  serializerImports,
  type KotlinIR,
  type KtEvent,
  type KtEvents,
} from "@abhigyakrishna/tspgen-kotlin";
import { NoTarget, type Program } from "@typespec/compiler";
import type { ServerOperation } from "./context.js";
import { encode } from "./helpers.js";

/** How a server-sent event stream is written: Ktor's `respondBytesWriter`, or the `ktor-server-sse` plugin's session. */
export type SseMode = "text-writer" | "plugin";

const MODES: readonly SseMode[] = ["text-writer", "plugin"];

/** `sse` from `@meta("kotlin:ktor-server", …)`, else the target option; invalid values warn. */
export function sseMode(program: Program, op: ServerOperation, fallback: SseMode): SseMode {
  const value = (op.meta["kotlin:ktor-server"] ?? {}).sse;
  if (value === undefined) return fallback;
  if (typeof value === "string" && (MODES as readonly string[]).includes(value)) return value as SseMode;
  reportDiagnostic(program, {
    code: "invalid-meta",
    format: { key: "sse", where: op.id, expected: '"text-writer" or "plugin"' },
    target: NoTarget,
  });
  return fallback;
}

/** The route statement streaming the service call's flow (`call`): one frame per event. */
export function streamLine(mode: SseMode, call: string): string {
  return `call.${mode === "plugin" ? "respondSse" : "respondEventStream"}(${call}) { it.sseFrame() }`;
}

/** Kotlin expression of an event's `data:` text: JSON through `serverJson`, strings as-is, other text payloads encoded. */
function dataExpr(e: KtEvent): string {
  if (e.literal !== undefined) return str(e.literal);
  const data = e.data!;
  if (e.json) {
    const serializer = serializerExpr(data);
    return serializer ? `serverJson.encodeToJsonElement(${serializer}, data).toString()` : "serverJson.encodeToJsonElement(data).toString()";
  }
  return data.nullable ? `data?.let { ${encode("it", data)} } ?: ""` : encode("data", data);
}

function frame(e: KtEvent, data: string): string {
  // The default event type needs no `event:` line.
  const event = e.event === "message" ? "null" : str(e.event);
  return `TspgenSseFrame(${event}, ${data}${e.terminal ? ", terminal = true" : ""})`;
}

/** ServerSupport.kt function turning an events value into its frame (`ChannelEvents.sseFrame()`). */
export function frameFunction(decl: KtEvents): string[] {
  const branches = decl.events.map((e) =>
    e.data
      ? `    is ${decl.name}.${e.name} -> ${frame(e, dataExpr(e))}`
      : `    ${decl.name}.${e.name} -> ${frame(e, dataExpr(e))}`,
  );
  return [
    `internal fun ${decl.name}.sseFrame(): TspgenSseFrame =`,
    ...(branches.length === 0 ? ["    error(\"no events\")"] : ["    when (this) {", ...branches.map((b) => `    ${b}`), "    }"]),
  ];
}

/** What ServerSupport.kt needs for the API's streams. */
export interface SsePlan {
  /** Events declarations streamed, deduplicated by FQN. */
  events: KtEvents[];
  sseMessage: boolean;
  textWriter: boolean;
  plugin: boolean;
  /** Some event has a JSON payload: it needs `serverJson`. */
  json: boolean;
}

export function ssePlan(ops: ServerOperation[]): SsePlan | undefined {
  const streams = ops.filter((op) => op.result.kind === "single" && op.result.stream);
  if (streams.length === 0) return undefined;
  const events = new Map<string, KtEvents>();
  let sseMessage = false;
  for (const op of streams) {
    const stream = op.result.kind === "single" ? op.result.stream! : undefined;
    if (stream?.events) events.set(stream.events.fqn, stream.events);
    else sseMessage = true;
  }
  const all = [...events.values()];
  return {
    events: all,
    sseMessage,
    textWriter: streams.some((op) => op.sse !== "plugin"),
    plugin: streams.some((op) => op.sse === "plugin"),
    json: all.some((d) => d.events.some((e) => e.json && e.data)),
  };
}

export function sseImports(plan: SsePlan, ir: KotlinIR, headers: boolean): string[] {
  return [
    "kotlinx.coroutines.flow.map",
    "kotlinx.coroutines.flow.transformWhile",
    ...(headers ? ["io.ktor.server.response.header"] : []),
    ...plan.events.map((d) => d.fqn),
    ...plan.events.flatMap((d) => d.events.flatMap((e) => (e.json && e.data ? serializerImports(e.data) : []))),
    ...(plan.sseMessage && ir.sseMessage ? [ir.sseMessage] : []),
    ...(plan.textWriter ? ["io.ktor.http.ContentType", "io.ktor.server.response.respondBytesWriter", "io.ktor.utils.io.writeStringUtf8"] : []),
    ...(plan.plugin
      ? [
          "io.ktor.server.application.plugin",
          "io.ktor.server.response.respond",
          "io.ktor.server.sse.SSE",
          "io.ktor.server.sse.SSEServerContent",
          "io.ktor.sse.ServerSentEvent",
        ]
      : []),
  ];
}

/** ServerSupport.kt functions routes in other packages import. */
export function sseFunctions(plan: SsePlan): string[] {
  return [
    "sseFrame",
    ...(plan.textWriter ? ["respondEventStream"] : []),
    ...(plan.plugin ? ["respondSse"] : []),
  ];
}
