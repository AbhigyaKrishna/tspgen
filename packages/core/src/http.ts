import type { StatusCodes } from "./ir/types.js";

export function isFixedStatus(codes: StatusCodes): codes is number {
  return typeof codes === "number";
}

export function isDefaultStatus(codes: StatusCodes): codes is "default" {
  return codes === "default";
}

/** Dispatch precedence: a fixed status, then a range, then the default. */
export function statusRank(codes: StatusCodes): number {
  return isDefaultStatus(codes) ? 2 : isFixedStatus(codes) ? 0 : 1;
}
