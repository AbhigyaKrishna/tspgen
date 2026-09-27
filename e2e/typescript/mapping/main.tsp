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

@route("/entries")
interface Entries {
  @get list(@query after?: utcDateTime): Entry[];
  @post create(@body entry: Entry): Entry;
}
