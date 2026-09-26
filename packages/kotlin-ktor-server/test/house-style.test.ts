import { expectDiagnostics } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { HEADER, server } from "./tester.js";

const graphSpec = `
  using TspGen;
  @service namespace Shop;
  namespace Graph {
    model Node { id: string; name: string }
    model CreateNodeRequest { name: string }
    @route("/graph/nodes") interface Nodes {
      @get listNodes(@query kind?: string): Node[];
      @post createNode(@body request: CreateNodeRequest): { @statusCode _: 201; @body node: Node };
      @get readNode(@path id: string): Node;
      @delete deleteNode(@path id: string): void;
    }
    @route("/graph/probe") interface Probe { @post probe(): void; }
  }
`;

const house = { grouping: "per-namespace", "service-suffix": "Api", module: false };

const permissions = `
  @@meta(Shop.Graph, "kotlin:ktor-server", #{
    wrap: #["authenticate(JWT_AUTH)"],
    imports: #["com.acme.core.JWT_AUTH", "com.acme.core.requirePermission"],
  });
  @@meta(Shop.Graph.Nodes.listNodes, "kotlin:ktor-server", #{ wrap: #["requirePermission(GraphModule.READ)"] });
  @@meta(Shop.Graph.Nodes.createNode, "kotlin:ktor-server", #{ wrap: #["requirePermission(GraphModule.WRITE)"] });
  @@meta(Shop.Graph.Nodes.readNode, "kotlin:ktor-server", #{ wrap: #["requirePermission(GraphModule.READ)"] });
  @@meta(Shop.Graph.Nodes.deleteNode, "kotlin:ktor-server", #{ wrap: #["requirePermission(GraphModule.WRITE)"] });
`;

const ROUTES = "server/com/acme/server/GraphRoutes.kt";

describe("ktor server house-style options", () => {
  it("names interfaces with the suffix, places units in mapped packages and skips the module", async () => {
    const { outputs } = await server(house, { packages: [{ namespace: "Shop.Graph", package: "com.acme.graph" }] }).compile(graphSpec);
    expect(Object.keys(outputs).filter((p) => p.startsWith("server/")).sort()).toEqual([
      "server/com/acme/graph/GraphApi.kt",
      "server/com/acme/graph/GraphRoutes.kt",
      "server/com/acme/server/ServerSupport.kt",
    ]);
    expect(outputs["server/com/acme/graph/GraphApi.kt"]).toBe(`${HEADER}
package com.acme.graph

interface GraphApi {
    suspend fun listNodes(kind: String?): List<Node>
    suspend fun createNode(request: CreateNodeRequest): Node
    suspend fun readNode(id: String): Node
    suspend fun deleteNode(id: String)
    suspend fun probe()
}
`);
    const routes = outputs["server/com/acme/graph/GraphRoutes.kt"];
    expect(routes).toContain("package com.acme.graph\n");
    expect(routes).toContain("import com.acme.server.pathParam\n");
    expect(routes).toContain("import com.acme.server.queryParam\n");
    expect(routes).toContain("fun Route.graphRoutes(service: GraphApi) {");
  });

  it("imports units from mapped packages into the module", async () => {
    const { outputs } = await server({ grouping: "per-namespace" }, { packages: [{ namespace: "Shop.Graph", package: "com.acme.graph" }] }).compile(
      graphSpec,
    );
    const module = outputs["server/com/acme/server/ShopModule.kt"];
    expect(module).toContain("import com.acme.graph.GraphService\n");
    expect(module).toContain("import com.acme.graph.graphRoutes\n");
    expect(module).toContain("fun Application.shopModule(graphService: GraphService) {");
  });

  it("puts a unit in a mapped package only when all its groups share it", async () => {
    const { outputs } = await server({ grouping: "single-file" }, { packages: [{ namespace: "Shop.Graph", package: "com.acme.graph" }] }).compile(`
      @service namespace Shop;
      @route("/ping") interface Ping { @get ping(): void; }
      namespace Graph {
        @route("/graph") interface Nodes { @get list(): string[]; }
      }
    `);
    const unitFiles = Object.keys(outputs).filter((p) => /Service\.kt$|Routes\.kt$/.test(p));
    expect(unitFiles.sort()).toEqual(["server/com/acme/server/ShopRoutes.kt", "server/com/acme/server/ShopService.kt"]);
  });

  it("renders wrap chains as a shared wrapper tree", async () => {
    const { outputs } = await server(house).compile(graphSpec + permissions);
    const routes = outputs[ROUTES];
    expect(routes).toContain("import com.acme.core.JWT_AUTH\n");
    expect(routes).toContain("import com.acme.core.requirePermission\n");
    expect(routes).toContain(`fun Route.graphRoutes(service: GraphApi) {
    authenticate(JWT_AUTH) {
        requirePermission(GraphModule.READ) {
            get("/graph/nodes") {
                val kind = call.queryParam("kind")
                call.respond(HttpStatusCode.OK, service.listNodes(kind))
            }
            get("/graph/nodes/{id}") {
                val id = call.pathParam("id")
                call.respond(HttpStatusCode.OK, service.readNode(id))
            }
        }
        requirePermission(GraphModule.WRITE) {
            post("/graph/nodes") {
                val request = call.receive<CreateNodeRequest>()
                call.respond(HttpStatusCode.Created, service.createNode(request))
            }
            delete("/graph/nodes/{id}") {
                val id = call.pathParam("id")
                service.deleteNode(id)
                call.respond(HttpStatusCode.NoContent)
            }
        }
        post("/graph/probe") {
            service.probe()
            call.respond(HttpStatusCode.NoContent)
        }
    }
}
`);
  });

  it("nests routes under their common prefix and splits route sets into their own functions", async () => {
    const { outputs } = await server({ ...house, "nest-routes": true }).compile(
      graphSpec + permissions + `@@meta(Shop.Graph.Probe, "kotlin:ktor-server", #{ routeSet: "unmanaged" });`,
    );
    const routes = outputs[ROUTES];
    expect(routes).toContain("import io.ktor.server.routing.route\n");
    expect(routes).toContain(`fun Route.graphRoutes(service: GraphApi) {
    route("/graph/nodes") {
        authenticate(JWT_AUTH) {
            requirePermission(GraphModule.READ) {
                get {
                    val kind = call.queryParam("kind")
                    call.respond(HttpStatusCode.OK, service.listNodes(kind))
                }
                get("/{id}") {
                    val id = call.pathParam("id")
                    call.respond(HttpStatusCode.OK, service.readNode(id))
                }
            }
            requirePermission(GraphModule.WRITE) {
                post {
                    val request = call.receive<CreateNodeRequest>()
                    call.respond(HttpStatusCode.Created, service.createNode(request))
                }
                delete("/{id}") {
                    val id = call.pathParam("id")
                    service.deleteNode(id)
                    call.respond(HttpStatusCode.NoContent)
                }
            }
        }
    }
}

fun Route.graphUnmanagedRoutes(service: GraphApi) {
    route("/graph/probe") {
        authenticate(JWT_AUTH) {
            post {
                service.probe()
                call.respond(HttpStatusCode.NoContent)
            }
        }
    }
}
`);
  });

  it("mounts every route function in the module", async () => {
    const partial = await server({ grouping: "per-namespace" }).compile(graphSpec + `@@meta(Shop.Graph.Probe, "kotlin:ktor-server", #{ routeSet: "unmanaged" });`);
    expect(partial.outputs["server/com/acme/server/ShopModule.kt"]).toContain(`fun Route.shopApiRoutes(graphService: GraphService) {
    graphRoutes(graphService)
    graphUnmanagedRoutes(graphService)
}`);
    const whole = await server({ grouping: "per-namespace" }).compile(
      graphSpec + `@@meta(Shop.Graph, "kotlin:ktor-server", #{ routeSet: "unmanaged" });`,
    );
    expect(whole.outputs["server/com/acme/server/GraphRoutes.kt"]).not.toContain("fun Route.graphRoutes(");
    expect(whole.outputs["server/com/acme/server/ShopModule.kt"]).toContain(`fun Route.shopApiRoutes(graphService: GraphService) {
    graphUnmanagedRoutes(graphService)
}`);
  });

  it("merges route sets whose names render the same", async () => {
    const { outputs } = await server({ grouping: "per-namespace" }).compile(
      graphSpec +
        `@@meta(Shop.Graph.Nodes, "kotlin:ktor-server", #{ routeSet: "unmanaged" });
         @@meta(Shop.Graph.Probe, "kotlin:ktor-server", #{ routeSet: "Unmanaged" });`,
    );
    expect(outputs["server/com/acme/server/GraphRoutes.kt"].match(/fun Route\.graph\w*Routes/g)).toEqual(["fun Route.graphUnmanagedRoutes"]);
  });

  it("fails when a routeSet yields no function name", async () => {
    const [, diagnostics] = await server().compileAndDiagnose(graphSpec + `@@meta(Shop.Graph.Probe, "kotlin:ktor-server", #{ routeSet: "-" });`);
    expectDiagnostics(diagnostics, { code: "@abhigyakrishna/tspgen-core/target-failed", message: /routeSet '-'/ });
  });

  it("renders a wrapper declared on both namespace and operation once", async () => {
    const { outputs } = await server(house).compile(
      graphSpec + permissions + `@@meta(Shop.Graph.Probe.probe, "kotlin:ktor-server", #{ wrap: #["authenticate(JWT_AUTH)"] });`,
    );
    expect(outputs[ROUTES].match(/authenticate\(JWT_AUTH\)/g)).toHaveLength(1);
  });

  it("refuses wrap, routeSet and nest-routes outside the dsl routing style", async () => {
    const [, diagnostics] = await server({ ...house, "routing-style": "resources" }).compileAndDiagnose(graphSpec + permissions);
    expectDiagnostics(diagnostics, {
      code: "@abhigyakrishna/tspgen-core/target-failed",
      message: /need routing-style "dsl" \(got "resources"\)/,
    });
  });

  const pagedSpec = `
    using TspGen;
    @service namespace Shop;
    model PageParams { @query offset?: int32; @query limit?: int32 }
    model Node { id: string }
    @route("/nodes") interface Nodes {
      @get listNodes(@query kind?: string, ...PageParams): Node[];
      @get readNode(@path id: string): Node;
      @delete deleteNode(@path id: string): void;
    }
    @@meta(Shop, "kotlin:ktor-server", #{
      context: #[#{ name: "page", type: "com.acme.core.PageRequest", expr: "call.pageRequest()", replaces: #["offset", "limit"] }],
      imports: #["com.acme.core.pageRequest"],
    });
    @@meta(Shop.Nodes.deleteNode, "kotlin:ktor-server", #{
      context: #[#{ name: "actorId", type: "String", expr: "call.requirePrincipal().userId" }],
    });
  `;

  it("adds context parameters last and replaces the HTTP parameters they stand for", async () => {
    const { outputs } = await server().compile(pagedSpec);
    expect(outputs["server/com/acme/server/NodesService.kt"]).toBe(`${HEADER}
package com.acme.server

import com.acme.core.PageRequest
import com.acme.models.Node

interface NodesService {
    suspend fun listNodes(kind: String?, page: PageRequest): List<Node>
    suspend fun readNode(id: String): Node
    suspend fun deleteNode(id: String, actorId: String)
}
`);
    const routes = outputs["server/com/acme/server/NodesRoutes.kt"];
    expect(routes).toContain("import com.acme.core.PageRequest\n");
    expect(routes).toContain("import com.acme.core.pageRequest\n");
    expect(routes).toContain(`    get("/nodes") {
        val kind = call.queryParam("kind")
        val page = call.pageRequest()
        call.respond(HttpStatusCode.OK, service.listNodes(kind, page))
    }`);
    expect(routes).toContain(`    delete("/nodes/{id}") {
        val id = call.pathParam("id")
        val actorId = call.requirePrincipal().userId
        service.deleteNode(id, actorId)
        call.respond(HttpStatusCode.NoContent)
    }`);
  });

  it("fails when a context parameter clashes with a request parameter", async () => {
    const [, diagnostics] = await server().compileAndDiagnose(`${pagedSpec}
      @@meta(Shop.Nodes.readNode, "kotlin:ktor-server", #{ context: #[#{ name: "id", type: "String", expr: "\\"x\\"" }] });
    `);
    expectDiagnostics(diagnostics, {
      code: "@abhigyakrishna/tspgen-core/target-failed",
      message: /context parameter 'id' clashes with a parameter of 'Shop.Nodes.readNode'/,
    });
  });

  it("accepts replaces as a single string, applying only where that parameter exists", async () => {
    const { outputs } = await server().compile(`
      using TspGen;
      @service namespace Shop;
      model Node { id: string }
      @route("/nodes") interface Nodes {
        @get listNodes(@query offset?: int32): Node[];
        @get readNode(@path id: string): Node;
      }
      @@meta(Shop, "kotlin:ktor-server", #{
        context: #[#{ name: "page", type: "com.acme.core.PageRequest", expr: "call.pageRequest()", replaces: "offset" }],
      });
    `);
    expect(outputs["server/com/acme/server/NodesService.kt"]).toBe(`${HEADER}
package com.acme.server

import com.acme.core.PageRequest
import com.acme.models.Node

interface NodesService {
    suspend fun listNodes(page: PageRequest): List<Node>
    suspend fun readNode(id: String): Node
}
`);
  });

  it("backtick-escapes a context name that is a Kotlin keyword", async () => {
    const { outputs } = await server().compile(`
      using TspGen;
      @service namespace Shop;
      model Node { id: string }
      @route("/nodes") interface Nodes {
        @get readNode(@path id: string): Node;
      }
      @@meta(Shop.Nodes.readNode, "kotlin:ktor-server", #{
        context: #[#{ name: "object", type: "String", expr: "call.attributes[SubjectKey]" }],
      });
    `);
    expect(outputs["server/com/acme/server/NodesService.kt"]).toContain(
      "suspend fun readNode(id: String, `object`: String): Node",
    );
    expect(outputs["server/com/acme/server/NodesRoutes.kt"]).toContain(
      "        val `object` = call.attributes[SubjectKey]\n",
    );
  });

  it("fails when a context parameter clashes with a reserved handler identifier", async () => {
    const [, diagnostics] = await server().compileAndDiagnose(`
      using TspGen;
      @service namespace Shop;
      model Node { id: string }
      @route("/nodes") interface Nodes {
        @get readNode(@path id: string): Node;
      }
      @@meta(Shop.Nodes.readNode, "kotlin:ktor-server", #{
        context: #[#{ name: "service", type: "String", expr: "\\"x\\"" }],
      });
    `);
    expectDiagnostics(diagnostics, {
      code: "@abhigyakrishna/tspgen-core/target-failed",
      message: /context parameter 'service' clashes with a parameter of 'Shop.Nodes.readNode'/,
    });
  });

  it("fails when replaces names a path parameter", async () => {
    const [, diagnostics] = await server().compileAndDiagnose(`
      using TspGen;
      @service namespace Shop;
      model Node { id: string }
      @route("/nodes") interface Nodes {
        @get readNode(@path id: string): Node;
      }
      @@meta(Shop.Nodes.readNode, "kotlin:ktor-server", #{
        context: #[#{ name: "page", type: "String", expr: "\\"x\\"", replaces: #["id"] }],
      });
    `);
    expectDiagnostics(diagnostics, {
      code: "@abhigyakrishna/tspgen-core/target-failed",
      message: /context 'page' on 'Shop\.Nodes\.readNode' cannot replace path parameter 'id'/,
    });
  });
});
