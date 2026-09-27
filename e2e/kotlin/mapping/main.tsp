import "@typespec/http";
import "@abhigyakrishna/tspgen-kotlin";

using Http;
using TspGen;

/** Type mapping end to end: BigDecimal, @encode(string) numbers, value-class scalars and the enum-unknown fallback. */
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
