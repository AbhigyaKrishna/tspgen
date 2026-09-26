import "@typespec/http";

using Http;

@service
namespace Shop;

model Page<T> {
  items: T[];
  total: int64;
  offset: int32;
  limit: int32;
}

model PageParams {
  @query offset?: int32;
  @query limit?: int32;
}

scalar isoInstant extends utcDateTime;

@error
model NotFound {
  @statusCode _: 404;
  message: string;
}

model ErrorResponse {
  status: int32;
  code: string;
  message: string;
  correlationId?: string;
}

namespace Graph {
  enum NodeKind { DATABASE, QUEUE }

  model Node {
    id: string;
    kind: NodeKind;
    name: string;
    createdAt: isoInstant;
  }

  model CreateNodeRequest {
    @minLength(1) @maxLength(200) name: string;
    kind: NodeKind;
  }

  @route("/graph/nodes")
  interface Nodes {
    @get listNodes(@query kind?: NodeKind, ...PageParams): Page<Node>;
    @post createNode(@body request: CreateNodeRequest): { @statusCode _: 201; @body node: Node };
    @get readNode(@path id: string): Node | NotFound;
    @delete deleteNode(@path id: string): void | NotFound;
  }

  @route("/graph/probe")
  interface Probe {
    @post probe(): { ok: boolean };
  }
}
