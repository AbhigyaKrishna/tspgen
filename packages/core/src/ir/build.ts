import type { Program } from "@typespec/compiler";
import { buildServices } from "./services.js";
import { TypeCollector } from "./type-collector.js";
import type { ApiIR } from "./types.js";
import { resolveServices, type ResolvedService, type VersioningApi } from "./versioning.js";

export interface BuildOptions {
  /** Collect expressible template models once as generic models (default true). */
  generics?: boolean;
  /**
   * `@typespec/versioning` (see `loadVersioning`). Without it, versioned services are built unmutated
   * (every type, property and operation of every version).
   */
  versioning?: VersioningApi;
  /** Version (enum member name or value) of the versioned services to build; the latest when unset. */
  version?: string;
  /**
   * Services already resolved with `resolveServices` (which reports whether resolution failed); `versioning`
   * and `version` are then unused. Otherwise services are resolved here and a service without the version
   * is skipped.
   */
  services?: ResolvedService[];
}

export function buildApiIR(program: Program, options: BuildOptions = {}): ApiIR {
  const collector = new TypeCollector(program, { generics: options.generics ?? true });
  const resolved = options.services ?? resolveServices(program, options.versioning, options.version).services;
  const services = buildServices(program, collector, resolved);
  return { services, types: collector.getTypes() };
}
