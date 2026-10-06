import { describe, expect, it } from "vitest";
import { isDefaultStatus, isFixedStatus, statusRank, type StatusCodes } from "../src/index.js";

describe("HTTP status dispatch", () => {
  it("orders fixed statuses before ranges and fallbacks, retaining declaration order within each kind", () => {
    const codes: StatusCodes[] = ["default", { start: 500, end: 599 }, 409, { start: 400, end: 499 }, 404];
    expect([...codes].sort((a, b) => statusRank(a) - statusRank(b))).toEqual([
      409, 404, { start: 500, end: 599 }, { start: 400, end: 499 }, "default",
    ]);
    expect(codes[0]).toBe("default");
  });

  it("can move only the default last while preserving declared fixed/range order", () => {
    const codes: StatusCodes[] = [{ start: 400, end: 499 }, "default", 404, { start: 500, end: 599 }, 503];
    expect([...codes].sort((a, b) => Number(isDefaultStatus(a)) - Number(isDefaultStatus(b)))).toEqual([
      { start: 400, end: 499 }, 404, { start: 500, end: 599 }, 503, "default",
    ]);
  });

  it("distinguishes a one-status range from a fixed status and the fallback", () => {
    const codes: StatusCodes[] = [404, { start: 404, end: 404 }, "default"];
    expect(codes.map(isFixedStatus)).toEqual([true, false, false]);
    expect(codes.map(isDefaultStatus)).toEqual([false, false, true]);
  });
});
