import "@tspgen/emitter-kotlin";
import "@tspgen/emitter-typescript";
import "./api.tsp";

using TspGen;

@@Kotlin.type(Shop.Page, "com.example.core.Page");
@@Kotlin.type(Shop.isoInstant, "com.example.core.IsoInstant");

@@meta(Shop, "kotlin:ktor-server", #{
  context: #[#{ name: "page", type: "com.example.core.PageRequest", expr: "call.pageRequest()", replaces: #["offset", "limit"] }],
  imports: #["com.example.core.pageRequest"],
});

@@meta(Shop.Graph.Probe, "kotlin:ktor-server", #{ routeSet: "unmanaged" });

@@TS.type(Shop.Page, "Page", "../page");
@@meta(Shop.Graph.NodeKind, "typescript", #{ values: "NODE_KINDS" });
