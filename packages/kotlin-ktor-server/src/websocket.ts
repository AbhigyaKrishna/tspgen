import { resolveMeta } from "@abhigyakrishna/tspgen-core";
import type { ServerOperation } from "./context.js";

/** The native Ktor session owns frame handling and stays inside the generated service call. */
export function withWebSocket(operation: ServerOperation): ServerOperation {
  const value = resolveMeta(operation.meta, "kotlin", "ktor-server").webSocket;
  if (value === undefined || value === false) return operation;
  if (value !== true) throw new Error(`webSocket metadata on '${operation.id}' must be a boolean`);
  const payload = operation.responses.some((response) => !response.isError && (response.body || response.headers.length));
  if (operation.verb !== "get" || operation.body || payload) {
    throw new Error(`WebSocket '${operation.id}' must be a GET operation without request bodies, success bodies or success headers`);
  }
  const taken = new Set([...operation.params.map((parameter) => parameter.name), ...operation.context.map((parameter) => parameter.name)]);
  let name = "session";
  while (taken.has(name)) name += "Socket";
  return {
    ...operation, webSocket: true,
    context: [...operation.context, {
      name, expr: "this",
      type: { text: "io.ktor.server.websocket.DefaultWebSocketServerSession", imports: [], nullable: false },
    }],
  };
}
