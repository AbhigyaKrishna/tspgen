import type { Program } from "@typespec/compiler";
import { buildServices } from "./services.js";
import { TypeCollector } from "./type-collector.js";
import type { ApiIR } from "./types.js";

export interface BuildOptions {
  /** Collect expressible template models once as generic models (default true). */
  generics?: boolean;
}

export function buildApiIR(program: Program, options: BuildOptions = {}): ApiIR {
  const collector = new TypeCollector(program, { generics: options.generics ?? true });
  const services = buildServices(program, collector);
  return { services, types: collector.getTypes() };
}
