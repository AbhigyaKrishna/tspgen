import "@typespec/http";
import "@typespec/http/streams";
import "@abhigyakrishna/tspgen-kotlin";
using Http;
using TypeSpec.Http.Streams;

@service namespace RawStreams;

model Message { prefix: string; }

@route("/raw") interface Streams {
  @get @route("/bytes") binary(): HttpStream<bytes, "application/octet-stream", bytes>;
  @get @route("/endless") endless(): HttpStream<bytes, "application/octet-stream", bytes>;
  @get @route("/text") text(): HttpStream<string, "text/plain">;
  @get @route("/utf16") utf16(): HttpStream<string, "text/plain; charset=UTF-16">;
  @post @route("/bytes") upload(...HttpStream<bytes, "application/octet-stream", bytes>): int32;
  @post @route("/text") uploadText(...HttpStream<string, "text/plain">): int32;
  @post @route("/utf16") uploadUtf16(...HttpStream<string, "text/plain; charset=UTF-16">): int32;
  @get @route("/metadata") withHeaders(@query empty?: boolean): {
    @statusCode status: 206;
    @header trace: string;
    ...HttpStream<bytes, "application/octet-stream", bytes>;
  } | { @statusCode status: 204; };
  @post @route("/events") events(@body message: Message): {
    @header contentType: "text/event-stream"; @body body: string;
  };
}
