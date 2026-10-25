import { resolveMeta } from "@abhigyakrishna/tspgen-core";
import type { KtOperation } from "@abhigyakrishna/tspgen-kotlin";

/** A WebSocket handshake has no HTTP body; frame serialization belongs to the scoped session. */
export function webSocketOperation(op: KtOperation): boolean {
  const value = resolveMeta(op.meta, "kotlin", "ktor-client").webSocket;
  if (value === undefined || value === false) return false;
  if (value !== true) throw new Error(`webSocket metadata on '${op.id}' must be a boolean`);
  const hasSuccessPayload = op.responses.some((response) => !response.isError && (response.body || response.headers.length > 0));
  if (op.verb !== "get" || op.body || hasSuccessPayload) {
    throw new Error(`WebSocket '${op.id}' must be a GET operation without request bodies, success bodies or success headers`);
  }
  return true;
}
