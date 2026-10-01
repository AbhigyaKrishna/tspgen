import { NoTarget, type Program } from "@typespec/compiler";
import { reportDiagnostic } from "../lib.js";
import type { GoType } from "./model.js";

export function unsupported(program: Program | undefined, id: string, reason: string): GoType {
  if (program) reportDiagnostic(program, { code: "unsupported-type", format: { id, reason }, target: NoTarget });
  return { text: "any", pointer: false };
}
