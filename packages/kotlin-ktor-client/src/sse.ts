import {
  kotlinString as str,
  type KotlinIR,
  type KtEvent,
  type KtEvents,
  type KtOperation,
  type KtStream,
} from "@abhigyakrishna/tspgen-kotlin";
import { decode } from "./helpers.js";

/** The stream of a server-sent event operation, if it is one. */
export function streamOf(op: KtOperation): KtStream | undefined {
  return op.result.kind === "single" ? op.result.stream : undefined;
}

/** `decode<Events>`: ClientSupport.kt's function turning a parsed event into an events value (null when unknown). */
export function decodeFunction(decl: KtEvents): string {
  return `decode${decl.name}`;
}

/** Whether an events type has a JSON payload (its decoder then takes the Json). */
export function usesJson(decl: KtEvents): boolean {
  return decl.events.some((e) => e.json && e.data !== undefined);
}

/** Kotlin expression of an event's payload from `event.data`. */
function payloadExpr(e: KtEvent): string {
  const data = e.data!;
  const text = data.text.replace(/\?$/, "");
  if (e.json) return `json.decodeFromString<${data.text}>(event.data)`;
  return decode("event.data", text, data.imports);
}

function valueExpr(decl: KtEvents, e: KtEvent): string {
  return e.data ? `${decl.name}.${e.name}(${payloadExpr(e)})` : `${decl.name}.${e.name}`;
}

/**
 * ClientSupport.kt functions of an events type: `decode<Events>` picks the event by name (events sharing a name, as
 * unnamed "message" variants do, by literal data first) and `sseTerminal` tells whether it ends the stream.
 */
export function eventFunctions(decl: KtEvents): string[] {
  const byName = new Map<string, KtEvent[]>();
  for (const e of decl.events) byName.set(e.event, [...(byName.get(e.event) ?? []), e]);
  const branches = [...byName].map(([name, events]) => {
    const literals = events.filter((e) => e.literal !== undefined);
    const fallback = events.find((e) => e.literal === undefined);
    const rest = fallback ? valueExpr(decl, fallback) : "null";
    if (literals.length === 0) return `        ${str(name)} -> ${rest}`;
    return [
      `        ${str(name)} ->`,
      "            when (event.data) {",
      ...literals.map((e) => `                ${str(e.literal!)} -> ${valueExpr(decl, e)}`),
      `                else -> ${rest}`,
      "            }",
    ].join("\n");
  });
  const terminal = decl.events.filter((e) => e.terminal).map((e) => `this is ${decl.name}.${e.name}`);
  return [
    [
      `/** The ${decl.name} value of [event]; null for an event this API does not declare. */`,
      `internal fun ${decodeFunction(decl)}(event: TspgenSseEvent${usesJson(decl) ? ", json: Json" : ""}): ${decl.name}? =`,
      "    when (event.event ?: \"message\") {",
      ...branches,
      "        else -> null",
      "    }",
    ].join("\n"),
    `internal fun ${decl.name}.sseTerminal(): Boolean = ${terminal.length > 0 ? terminal.join(" || ") : "false"}`,
  ];
}

/** Events declarations streamed by `ops`, deduplicated by FQN, and whether an untyped stream is among them. */
export function streamsOf(ops: KtOperation[]): { events: KtEvents[]; untyped: boolean; any: boolean } {
  const events = new Map<string, KtEvents>();
  let untyped = false;
  let any = false;
  for (const op of ops) {
    const stream = streamOf(op);
    if (!stream) continue;
    any = true;
    if (stream.events) events.set(stream.events.fqn, stream.events);
    else untyped = true;
  }
  return { events: [...events.values()], untyped, any };
}

export function supportImports(ir: KotlinIR, streams: ReturnType<typeof streamsOf>): string[] {
  if (!streams.any) return [];
  const json = streams.events.some(usesJson);
  return [
    "io.ktor.utils.io.ByteReadChannel",
    "io.ktor.utils.io.readAvailable",
    ...streams.events.flatMap((d) => [d.fqn, ...d.events.flatMap((e) => (e.data ? e.data.imports : []))]),
    ...(json
      ? [
          "io.ktor.client.HttpClient",
          "io.ktor.client.plugins.api.ClientPlugin",
          "io.ktor.client.plugins.api.createClientPlugin",
          "io.ktor.util.AttributeKey",
          ...(ir.javaTimeModule ? [ir.javaTimeModule] : []),
        ]
      : []),
  ];
}

/** Statements of a streaming client method before the request: the Json of JSON payloads. */
export function preludeLines(stream: KtStream): string[] {
  return stream.events && usesJson(stream.events) ? ["val json = http.sseJson"] : [];
}

/** Statements of a streaming client method after the response arrived: decode and emit each event. */
export function emitLines(stream: KtStream): string[] {
  if (!stream.events) return ["emit(SseMessage(event.data, event.event, event.id))", "true"];
  const json = usesJson(stream.events) ? ", json" : "";
  return [
    `val value = ${decodeFunction(stream.events)}(event${json}) ?: return@readSse true`,
    "emit(value)",
    "!value.sseTerminal()",
  ];
}
