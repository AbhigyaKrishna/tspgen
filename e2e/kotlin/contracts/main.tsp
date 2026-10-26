import "@typespec/http";
import "@typespec/http/streams";
import "@typespec/events";
import "@typespec/sse";
import "@abhigyakrishna/tspgen-kotlin";
using Http;

@service namespace Contracts;

@encode(string) scalar ExternalId extends int64;
@minLength(2) scalar ShortName extends string;
@pattern("^[a-z]+$") scalar Slug extends ShortName;
@encode("unixTimestamp", int64) scalar Epoch extends utcDateTime;
@encode("seconds", float64) scalar Seconds extends duration;
model EncodedValues {
  @encode("rfc7231") date: utcDateTime;
  epoch: Epoch;
  @encode("rfc3339") reset: Epoch;
  values: Seconds[];
  @encode("milliseconds", int32) elapsed: duration;
  standard: unixTimestamp32;
}
model EncodedPrimitives {
  @encode(string) enabled: boolean;
  @encode(string) count: int32;
  @encode(ArrayEncoding.pipeDelimited) tags: string[];
  @encode(ArrayEncoding.commaDelimited) numbers: int32[];
}

model OpenModel { @encodedName("application/json", "display_name") name: string; ...Record<unknown>; }
model Numbers { count: int32; ...Record<int32>; }
model DerivedNumbers extends Numbers { total: int32; }
model Page<T> { items: T[]; }
model EncodedPage { page: Page<ExternalId>; }
model ExactNumbers { count: integer; exact: numeric; @encode(string) external: integer; }
@minValue(123456789012345678901234567890) scalar BoundedInteger extends integer;
model CompleteNumbers {
  value: decimal;
  @encode(string) text: decimal128;
  values: BoundedInteger[];
  @maxValueExclusive(0.1234567890123456789012345) fraction: numeric;
  @minValue(utcDateTime.fromISO("2025-01-01T00:00:00Z")) date: utcDateTime;
}
model ExactLiteral { value: 123456789012345678901234567890; }
model StrictOptional { label?: string; maybe?: string | null; nested?: Pet; }
model StrictOuter { settings: StrictOptional = #{ label: "ok" }; }
model NullableExtras { value: string | null; ...Record<unknown>; }
model ConstrainedExtras { ...Record<Slug>; }
model Serializer { known: string; ...Record<string>; }
model JsonObject { known: string; ...Record<unknown>; }
@discriminator("kind") model Animal { kind: string; name: string; }
model Cat extends Animal { kind: "cat"; ...Record<unknown>; }
model AnimalHolder { animal: Animal; }
model FirstVariant { key: "first"; value: string; }
model SecondVariant { key: "second"; count: int32; }
@discriminated(#{ envelope: "none", discriminatorPropertyName: "key" })
union NestedResult { first: FirstVariant, second: SecondVariant }
model NestedDefault { result: NestedResult = #{ key: "first", value: "x" }; animal: Animal = #{ kind: "cat", name: "Milo" }; }
@TspGen.meta("kotlin", #{ scalarStyle: "value-class" }) scalar Counter extends integer;
model CounterEncoding { @encode(string) value: Counter; }
model AAA { value: ZZZ = #{ known: "x", extra: 1 }; }
model ZZZ { known: string; ...Record<unknown>; }
model Box<T> { value: T; }
model GenericCodecs { boxes: Box<ExternalId>[]; optional?: Box<ExternalId> | null; }
model Geometry { point: [float64, float64]; metadata: [string, int32, boolean]; }
model Config { enabled: boolean; }
model Settings {
  kind: "settings";
  version: 2;
  tags: string[] = #["a", "b"];
  config: Config = #{ enabled: true };
  labels: Record<string> = #{ region: "east" };
}
model Validated { names: Slug[]; }
enum Code { ok: 1, failed: 2 }
enum Mixed { automatic: "auto", count: 3 }
enum HugeCode { exact: 123456789012345678901234567890 }
union State { ready: "ready", other: string }
model Pet { name: string; }
model TemplateBase<T> { value: T; }
model TemplateDerived<T> extends TemplateBase<T> { pair: [T, string]; }
model Failure { reason: string; }
union Outcome<T> { value: T, failure: Failure }
model Specialized { number: TemplateDerived<int32>; text: TemplateDerived<string>; outcome: Outcome<int32>; }
@TypeSpec.Events.events union PetUpdates { added: Pet, @TypeSpec.SSE.terminalEvent finished: "done" }
@discriminated(#{ discriminatorPropertyName: "kind", envelopePropertyName: "payload" })
union WireEnvelope { pet: Pet, message: string }
model ExactDefaults {
  code: HugeCode = HugeCode.exact;
  counts: integer[] = #[123456789012345678901234567890];
  byName: Record<numeric> = #{ exact: 12345678901234567890.1234567890123456789 };
  pet: WireEnvelope = #{ name: "Milo" };
  @encode("rfc7231") date: utcDateTime = utcDateTime.fromISO("2025-01-01T00:00:00Z");
}
model Probe { filter: Record<string>; code: Code; }
model Bundle { caption: HttpPart<string>; pet: HttpPart<Pet>; photo: HttpPart<File>; extra?: HttpPart<string>; }
model StreamInput { label: HttpPart<string>; }
@error model BundleError { @statusCode status: 404; @header contentType: "multipart/mixed"; @multipartBody body: Bundle; }
model ContractsKey is ApiKeyAuth<ApiKeyLocation.header, "X-Key">;

@route("/contracts/auth") interface Secured {
  @get @route("/mixed") @useAuth([BearerAuth, ContractsKey] | BasicAuth) mixed(): void;
  @get @route("/optional") @useAuth([BearerAuth, ContractsKey] | NoAuth) optional(): void;
}

@route("/contracts") interface Operations {
  @TspGen.meta("kotlin", #{ webSocket: true })
  @get @route("/socket") socket(): { @statusCode status: 101; };
  @TspGen.meta("kotlin", #{ webSocket: true })
  @get @route("/checked-socket") checkedSocket(@query @minValue(1) room: int32): { @statusCode status: 101; };
  @get @route("/checked") checked(@query @minValueExclusive(0) ratio: float64, @query mode: "strict"): string;
  @post @route("/checked-body") checkedBody(@header contentType: "application/json", @body @minLength(2) value: string): string;
  @get @route("/encoded") encoded(@query epoch: Epoch, @header @encode("rfc7231") date: utcDateTime): EncodedValues;
  @get @route("/delimited") delimited(@query @encode(ArrayEncoding.pipeDelimited) tags: string[]): string[];
  @post @route("/tuple-upload") uploadTuple(@header contentType: "multipart/form-data", @multipartBody body: [HttpPart<string, #{ name: "caption" }>, HttpPart<File, #{ name: "image" }>]): string;
  @TspGen.meta("kotlin:ktor-server", #{ multipart: "streaming" })
  @post @route("/stream-upload") streamUpload(@header contentType: "multipart/form-data", @multipartBody body: StreamInput): int32;
  @post @route("/mixed-upload") uploadMixed(@header contentType: "multipart/mixed", @multipartBody body: [HttpPart<Pet>, HttpPart<File>]): string;
  @post @route("/repeated-upload") uploadRepeated(@header contentType: "multipart/mixed", @multipartBody body: [HttpPart<string>, HttpPart<string>[]]): string;
  @get @route("/lines") lines(): TypeSpec.Http.Streams.JsonlStream<Pet>;
  @get @route("/lines-metadata") linesMetadata(@query empty?: boolean): { @statusCode status: 201; @header trace: string; ...TypeSpec.Http.Streams.JsonlStream<Pet>; } | { @statusCode status: 204; };
  @get @route("/events-metadata") eventsMetadata(): { @statusCode status: 202; @header trace: string; @header contentType: "text/event-stream"; @body body: string; };
  @TspGen.meta("kotlin:ktor-server", #{ sse: "plugin" })
  @get @route("/updates") updates(): { @statusCode status: 201; @header trace: string; ...TypeSpec.SSE.SSEStream<PetUpdates>; };
  @get @route("/mixed-stream") mixedStream(@query jsonl: boolean): TypeSpec.Http.Streams.JsonlStream<Pet> | { @header contentType: "text/event-stream"; @body body: string; };
  @post @route("/ingest") ingest(...TypeSpec.Http.Streams.JsonlStream<Pet>): int32;
  @get @route("/download") download(): File<"application/octet-stream">;
  @get @route("/bundle") bundle(): { @header contentType: "multipart/form-data"; @multipartBody body: Bundle; };
  @get @route("/bundle-error") bundleError(): void | BundleError;
  @get @route("/mixed-bundle") mixedBundle(): { @header contentType: "multipart/mixed"; @multipartBody body: [HttpPart<Pet>, HttpPart<File>]; };
  @get @route("/probe") probe(@query filter: Record<string>, @header code: Code): Probe;
  @post @route("/open") open(@body body: OpenModel): OpenModel;
  @post @route("/tuple") tuple(@body body: Geometry): Geometry;
  @post @route("/envelope") envelope(@body body: WireEnvelope): WireEnvelope;
}
