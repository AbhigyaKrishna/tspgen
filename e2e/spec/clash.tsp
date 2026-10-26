import "@typespec/http";
import "@typespec/events";
import "@typespec/sse";
import "@abhigyakrishna/tspgen-kotlin";

using Http;
using TspGen;

/** Models named like generated internals (Flow, SseEvent, SseFrame) streamed in both server modes; no java.time. */
@service
namespace Clash;

model Flow {
  rate: int32;
  unit?: string = "bpm";
  note?: string | null;
}

model SseEvent {
  id: string;
}

model SseFrame {
  n: int32;
}

@TypeSpec.Events.events
union Readings {
  flow: Flow,
  event: SseEvent,
  frame: SseFrame,
}

@route("/meter")
interface Meter {
  @get @route("/last") last(): Flow;
  @get @route("/stream") readings(): TypeSpec.SSE.SSEStream<Readings>;
  @get @route("/plugin") pluginReadings(): TypeSpec.SSE.SSEStream<Readings>;
}

@@meta(Clash.Meter.pluginReadings, "kotlin:ktor-server", #{ sse: "plugin" });
