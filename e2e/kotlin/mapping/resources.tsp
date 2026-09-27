import "@typespec/http";
import "@abhigyakrishna/tspgen-kotlin";

using Http;

/** routing-style: resources with a BigDecimal (and java.time) query parameter. */
@service
namespace LedgerSearch;

model Hit {
  amount: decimal;
}

@route("/search")
interface Search {
  @get find(@query min: decimal, @query at?: utcDateTime): Hit[];
}
