import "@specgen/emitter-kotlin";
import "./api.tsp";

using Specgen;

@@Kotlin.type(Shop.Page, "com.example.core.Page");
@@Kotlin.type(Shop.isoInstant, "com.example.core.IsoInstant");

@@meta(Shop, "kotlin:ktor-server", #{
  context: #[#{ name: "page", type: "com.example.core.PageRequest", expr: "call.pageRequest()", replaces: #["offset", "limit"] }],
  imports: #["com.example.core.pageRequest"],
});

@@meta(Shop.Graph.Probe, "kotlin:ktor-server", #{ routeSet: "unmanaged" });
