import "@typespec/http";
import "@typespec/streams";
import "@typespec/events";
import "@typespec/sse";
import "@abhigyakrishna/tspgen-kotlin";

using Http;
using TspGen;

/**
 * Type mapping end to end: BigDecimal, @encode(string) numbers (also as top-level bodies, events and parts), value-class
 * scalars and the enum-unknown fallback.
 */
@service
namespace Ledger;

/** Account ids travel as JSON strings. */
@encode(string)
scalar AccountId extends int64;

@minLength(2)
scalar Currency extends string;

/** A java.time-based scalar exercised as a query param and a response header. */
scalar SeenAt extends utcDateTime;

enum Status {
  open,
  closed,
}

/** Response-only: tiers a newer server adds must not break older clients. */
@meta("kotlin", #{ features: #{ `enum-unknown`: true } })
enum Tier {
  basic,
  gold,
}

model Account {
  id: AccountId;
  balance: decimal;
  currency: Currency;
  @encode(string) sequence: int64;
  holds: AccountId[];
  status: Status;
  tier: Tier;
  @encode(string) limit?: uint64;
  visits: uint64;
}

@route("/accounts")
interface Accounts {
  @get get(@path id: AccountId): Account;
  @post create(@body account: Account): Account;
  @get @route("/search") search(@query min: decimal, @query currency: Currency): Account[];

  /** value-class scalar as path and query param, and a java.time-based value class as a response header. */
  @get @route("/{id}/since")
  since(@path id: AccountId, @query seenAfter?: SeenAt): { @header seenAt: SeenAt; @body body: Account };
}

/** Entry ids: an inline Long travelling as a JSON string, also as a whole body, event payload and part. */
@encode(string)
@meta("kotlin", #{ scalarStyle: "inline" })
scalar EntryId extends int64;

/** The same as a typealias. */
@encode(string)
@meta("kotlin", #{ scalarStyle: "typealias" })
scalar BatchId extends int64;

@TypeSpec.Events.events
union EntryEvents {
  ids: EntryId[],
}

model EntryForm {
  ids: HttpPart<EntryId[]>;
  note: HttpPart<string>;
}

@route("/entries")
interface Entries {
  @get list(): EntryId[];
  @get @route("/one") one(): EntryId;
  @post take(@body ids: EntryId[]): EntryId[];
  @post @route("/batch") batch(@body ids: BatchId[]): BatchId;
  @get @route("/feed") feed(): TypeSpec.SSE.SSEStream<EntryEvents>;
  @post @route("/form") form(@header contentType: "multipart/form-data", @multipartBody body: EntryForm): EntryId[];
}
