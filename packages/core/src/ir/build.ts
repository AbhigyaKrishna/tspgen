import type { Model, Program } from "@typespec/compiler";
import { buildServices } from "./services.js";
import type { SseLibraries } from "./sse.js";
import { TypeCollector } from "./type-collector.js";
import type { ApiIR } from "./types.js";
import { resolveServices, type ResolvedService, type VersioningApi } from "./versioning.js";

export interface BuildOptions {
  /**
   * Collect expressible template models once as generic models (default true); a function decides per template
   * declaration (false: one model per instance).
   */
  generics?: boolean | ((declaration: Model) => boolean);
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
  /**
   * The SSE libraries (`loadSseLibraries`) for typed event streams; without them every `text/event-stream`
   * response is untyped.
   */
  sse?: SseLibraries;
}

export function buildApiIR(program: Program, options: BuildOptions = {}): ApiIR {
  const collector = new TypeCollector(program, { generics: options.generics ?? true, sse: options.sse });
  const resolved = options.services ?? resolveServices(program, options.versioning, options.version).services;
  const services = buildServices(program, collector, resolved, options.sse);
  return { services, types: collector.getTypes() };
}
