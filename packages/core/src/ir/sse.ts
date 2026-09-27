import type { Model, ModelProperty, Program, Type, Union, UnionVariant } from "@typespec/compiler";
import type { HttpOperationResponseContent } from "@typespec/http";

/**
 * The parts of `@typespec/streams`, `@typespec/events` and `@typespec/sse` typed SSE needs. They are optional peer
 * dependencies the pipeline loads (`loadSseLibraries`) when the program uses streams or events, and hands to
 * `buildApiIR`; without them a `text/event-stream` response is an untyped stream.
 */
export interface SseLibraries {
  getStreamOf(program: Program, model: Model): Type | undefined;
  isEvents(program: Program, union: Union): boolean;
  isTerminalEvent(program: Program, variant: UnionVariant): boolean;
  getEventDefinitions(program: Program, union: Union): [EventDefinition[], readonly unknown[]];
}

/** `@typespec/events/experimental`'s event definition (the fields read here). */
export interface EventDefinition {
  readonly eventType?: string;
  readonly root: UnionVariant;
  readonly payloadType: Type;
  readonly payloadContentType?: string;
}

export const EVENT_STREAM = "text/event-stream";

const STREAM_OF = Symbol.for("@typespec/streams/streamOf");
const EVENTS = Symbol.for("@typespec/events/events");

/**
 * Loads the SSE libraries (dynamic imports: they are optional peers and core has no top-level await, so it can be
 * `require`d). Undefined when any of them cannot be loaded.
 */
export async function loadSseLibraries(): Promise<SseLibraries | undefined> {
  // A variable specifier: the packages are optional, so they must not be resolved at compile time.
  const importOptional = (specifier: string): Promise<Record<string, unknown>> => import(specifier);
  try {
    const [streams, events, experimental, sse] = await Promise.all([
      importOptional("@typespec/streams"),
      importOptional("@typespec/events"),
      importOptional("@typespec/events/experimental"),
      importOptional("@typespec/sse"),
    ]);
    const libs = {
      getStreamOf: streams.getStreamOf,
      isEvents: events.isEvents,
      isTerminalEvent: sse.isTerminalEvent,
      getEventDefinitions: experimental.unsafe_getEventDefinitions,
    };
    return Object.values(libs).every((f) => typeof f === "function") ? (libs as SseLibraries) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the program uses streams or events (`@streamOf` / `@events` state, read without the libraries): only then
 * does the pipeline load them.
 */
export function usesSseLibraries(program: Program): boolean {
  return program.stateMap(STREAM_OF).size > 0 || program.stateSet(EVENTS).size > 0;
}

export function isEventStream(contentTypes: readonly string[]): boolean {
  return contentTypes.some((t) => t.split(";")[0].trim().toLowerCase() === EVENT_STREAM);
}

/** `streamOf` state of the `@streamOf` decorator, read without the library (to explain a missing one). */
export function declaresStream(program: Program, content: HttpOperationResponseContent): boolean {
  const models = streamModels(content);
  const state = program.stateMap(STREAM_OF);
  return models.some((m) => state.has(m));
}

/** Models whose `@streamOf` describes a response body: the body property's model, then its source properties'. */
function streamModels(content: HttpOperationResponseContent): Model[] {
  const models: Model[] = [];
  for (let prop: ModelProperty | undefined = content.body?.property; prop; prop = prop.sourceProperty) {
    if (prop.model) models.push(prop.model);
  }
  return models;
}

/**
 * The `@events` union a `text/event-stream` response streams (`SSEStream<Events>`), when the SSE libraries are
 * loaded and the body declares one; undefined for an untyped stream.
 */
export function streamEvents(
  program: Program,
  content: HttpOperationResponseContent,
  libs: SseLibraries | undefined,
): Union | undefined {
  if (!libs) return undefined;
  for (const model of streamModels(content)) {
    const of = libs.getStreamOf(program, model);
    if (of) return of.kind === "Union" && libs.isEvents(program, of) ? of : undefined;
  }
  return undefined;
}

/** Whether `union` is an `@events` union (always false without the libraries). */
export function isEventsUnion(program: Program, union: Union, libs: SseLibraries | undefined): boolean {
  return libs?.isEvents(program, union) ?? false;
}
