import "@typespec/http";
import "@typespec/events";
import "@typespec/sse";

using Http;

@service(#{ title: "Pet Store" })
namespace PetStore;

enum Species {
  dog,
  cat,
  bird: "parrot",
}

/** A pet in the store. */
model Pet {
  id: int64;
  name: string;
  species: Species;
  tags?: string[];
  @encodedName("application/json", "born_at") bornAt?: utcDateTime;
  weight?: float64 = 1.0;
}

@discriminator("kind")
model Toy {
  kind: string;
  name: string;
}

model Ball extends Toy {
  kind: "ball";
  diameter: float32;
}

model Rope extends Toy {
  kind: "rope";
  length: int32;
}

/** One page of results; generated once as a generic class. */
model Page<T> {
  items: T[];
  total: int32;
}

model Collar {
  size: int32;
}

model NameTag {
  text: string;
}

/** Variants only this union uses are generated inside it (Accessory.Collar, Accessory.Tag). */
@discriminated(#{ envelope: "none", discriminatorPropertyName: "type" })
union Accessory {
  collar: Collar,
  tag: NameTag,
}

@error
model ApiError {
  code: string;
  message: string;
}

@error
model NotFound {
  @statusCode _: 404;
  message: string;
}

@route("/pets")
interface Pets {
  @get list(
    @query limit?: int32,
    @query(#{ explode: true }) tags?: string[],
    @query species?: Species,
    @query bornAfter?: utcDateTime,
  ): Pet[] | ApiError;

  @get get(@path petId: int64, @header("x-trace") trace?: string): Pet | NotFound | ApiError;

  @post create(@body pet: Pet):
    | {
        @statusCode _: 201;
        @header location: string;
        @body pet: Pet;
      }
    | {
        @statusCode _: 200;
        @body pet: Pet;
      }
    | ApiError;

  @delete remove(@path petId: int64): void | NotFound;

  /** Bare java.time bodies need the generated contextual serializers. */
  @post @route("/latest") latest(@body dates: utcDateTime[]): utcDateTime;
}

@route("/toys")
interface Toys {
  @get list(): Toy[];
  @post add(@body toy: Toy): void;
}

@route("/accessories")
interface Accessories {
  @get page(@query offset?: int32): Page<Accessory>;
  @post add(@body accessory: Accessory): void;
}

/** A photo upload: text, JSON and file parts. */
model PhotoUpload {
  caption: HttpPart<string>;
  rating?: HttpPart<int32>;
  pet: HttpPart<Pet>;
  photo: HttpPart<File>;
  extras?: HttpPart<File>[];
}

/** What the server read from a multipart upload. */
model UploadReceipt {
  caption: string;
  rating?: int32;
  petName: string;

  /** `<part>:<filename>:<content type>:<text>` per file part, in arrival order. */
  files: string[];
}

/** What the server read from a file body. */
model FileReceipt {
  filename?: string;
  contentType?: string;
  text: string;
}

/** One operation per server multipart mode (kotlin.tsp sets the modes). */
@route("/uploads")
interface Uploads {
  @post @route("/buffered") buffered(
    @header contentType: "multipart/form-data",
    @multipartBody body: PhotoUpload,
  ): UploadReceipt;

  @post @route("/streaming") streaming(
    @header contentType: "multipart/form-data",
    @multipartBody body: PhotoUpload,
  ): UploadReceipt;

  @post @route("/raw") raw(@header contentType: "multipart/form-data", @multipartBody body: PhotoUpload): UploadReceipt;
  @put @route("/file") file(@bodyRoot file: File): FileReceipt;
  @put @route("/file-stream") fileStream(@bodyRoot file: File): FileReceipt;
}

/** Events of the pet feed: one per variant, sent as server-sent events. */
@TypeSpec.Events.events
union PetEvents {
  /** A pet was added. */
  added: Pet,

  /** Free text; may span several lines. */
  @TypeSpec.Events.contentType("text/plain")
  note: string,

  count: int32,

  /** When the feed was last read: a bare java.time payload in Kotlin. */
  seen: utcDateTime,

  /** Ends the stream. */
  @TypeSpec.Events.contentType("text/plain")
  @TypeSpec.SSE.terminalEvent
  "[done]",
}

model FeedFilter {
  species?: Species;
  endless?: boolean;
}

/** Server-sent event streams: typed (text writer and SSE plugin, see kotlin.tsp) and untyped. */
@route("/feed")
interface Feed {
  /** `fail` answers 404 / 400 before streaming; `endless` streams until the client stops. */
  @get watch(@query fail?: int32, @query endless?: boolean): TypeSpec.SSE.SSEStream<PetEvents> | NotFound | ApiError;

  @post @route("/plugin") watchPlugin(@body filter: FeedFilter): TypeSpec.SSE.SSEStream<PetEvents> | NotFound;

  /** Untyped: `count` messages with an id each. */
  @get @route("/raw") raw(@query count: int32): {
    @header contentType: "text/event-stream";
    @body body: string;
  };
}
