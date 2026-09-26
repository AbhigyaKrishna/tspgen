import type { Program } from "@typespec/compiler";
import { buildServices } from "./services.js";
import { TypeCollector } from "./type-collector.js";
import type { ApiIR } from "./types.js";

export function buildApiIR(program: Program): ApiIR {
  const collector = new TypeCollector(program);
  const services = buildServices(program, collector);
  return { services, types: collector.getTypes() };
}
