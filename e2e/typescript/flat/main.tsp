import "@typespec/http";
import "@typespec/events";
import "@typespec/sse";
import "@abhigyakrishna/tspgen-typescript";

using Http;

/** The pet feed of petstore.tsp for the flat client style (the full pet store needs the grouped style). */
@service
namespace PetFeed;

enum Species {
  dog,
  cat,
  bird: "parrot",
}

model Pet {
  id: int64;
  name: string;
  species: Species;
  @encodedName("application/json", "born_at") bornAt?: utcDateTime;
}

@TypeSpec.Events.events
union PetEvents {
  added: Pet,

  @TypeSpec.Events.contentType("text/plain")
  note: string,

  count: int32,
  seen: utcDateTime,

  @TypeSpec.Events.contentType("text/plain")
  @TypeSpec.SSE.terminalEvent
  "[done]",
}

model FeedFilter {
  species?: Species;
  endless?: boolean;
}

@route("/feed")
interface Feed {
  @get watch(@query fail?: int32, @query endless?: boolean): TypeSpec.SSE.SSEStream<PetEvents>;
  @post @route("/plugin") watchPlugin(@body filter: FeedFilter): TypeSpec.SSE.SSEStream<PetEvents>;
  @get @route("/raw") raw(@query count: int32): {
    @header contentType: "text/event-stream";
    @body body: string;
  };
}
