import "@typespec/http";
import "@abhigyakrishna/tspgen-typescript";

using Http;

/** date-type: date in both Next.js client styles, on the wire format the Kotlin mapping e2e writes. */
@service
namespace Ledger;

model Entry {
  title: string;
  at: utcDateTime;
  @encode(string) sequence: int64;
  amount: decimal;
  reminders?: utcDateTime[];
}

/** Entry ids beyond 2^53 travel as JSON strings, also as whole bodies (as the Kotlin mapping e2e writes them). */
@encode(string)
scalar EntryId extends int64;

@route("/entries")
interface Entries {
  @get @route("/ids") ids(): EntryId[];
  @post @route("/ids") take(@body ids: EntryId[]): EntryId[];
  @get list(@query after?: utcDateTime): Entry[];
  @post create(@body entry: Entry): Entry;
}
