import { reportDiagnostic, reportUnsupportedFeature, type ResolvedFeatures } from "@abhigyakrishna/tspgen-core";
import { kotlinString, type KotlinIR } from "@abhigyakrishna/tspgen-kotlin";
import { NoTarget, type Program } from "@typespec/compiler";
import type { KtorServerOptions } from "./options.js";

const TARGET_NAME = "@abhigyakrishna/tspgen-kotlin-ktor-server";

/** Response headers Ktor refuses to set by hand (UnsafeHeaderException); the event-stream writers own them. */
const WRITER_HEADERS = ["content-type", "content-length", "transfer-encoding", "upgrade"];

/** Module-wide settings of the generated server runtime code: features and flat options, resolved once. */
export interface ServerRuntime {
  /** `features.module`: `<Service>Module.kt` is emitted. */
  module: boolean;
  /** The module installs StatusPages (`features.module` and `features.status-pages`). */
  statusPages: boolean;
  errorBody: "problem" | "none";
  ignoreUnknownKeys: boolean;
  encodeDefaults: boolean;
  /** `sse-headers` entries as Kotlin string literals, in configured order. */
  sseHeaders: [string, string][];
}

export function serverRuntime(options: KtorServerOptions): ServerRuntime {
  const features = options.features;
  return {
    module: features.module,
    statusPages: features.module && features["status-pages"],
    errorBody: options["error-body"] ?? "problem",
    ignoreUnknownKeys: features["ignore-unknown-keys"],
    encodeDefaults: features["encode-defaults"],
    sseHeaders: Object.entries(options["sse-headers"] ?? { "Cache-Control": "no-store", "X-Accel-Buffering": "no" }).map(
      ([name, value]) => [kotlinString(name), kotlinString(value)],
    ),
  };
}

/**
 * Option checks the JSON schema cannot express. `sse-headers` naming a writer-owned header is an error (the server
 * code is not emitted); `features.status-pages: true` set explicitly with `features.module: false` warns.
 */
export function checkRuntime(program: Program, options: KtorServerOptions, features: ResolvedFeatures<string>): boolean {
  if (!options.features.module) reportUnsupportedFeature(program, features, "status-pages", "features.module: false");
  const owned = Object.keys(options["sse-headers"] ?? {}).filter((name) => WRITER_HEADERS.includes(name.toLowerCase()));
  if (owned.length === 0) return true;
  reportDiagnostic(program, {
    code: "invalid-target-options",
    format: {
      name: TARGET_NAME,
      errors: owned.map((name) => `sse-headers.${name} is set by the event-stream writer; remove it`).join("; "),
    },
    target: NoTarget,
  });
  return false;
}

/** `internal val serverJson`: Ktor's DefaultJson with the target's features and the models' serializers. */
export function serverJsonLines(ir: KotlinIR, runtime: ServerRuntime): string[] {
  const module = ir.serializersModule ? ir.serializersModule.slice(ir.serializersModule.lastIndexOf(".") + 1) : undefined;
  return [
    "internal val serverJson: Json = Json(DefaultJson) {",
    `    encodeDefaults = ${runtime.encodeDefaults}`,
    ...(runtime.ignoreUnknownKeys ? ["    ignoreUnknownKeys = true"] : []),
    ...(module ? [`    serializersModule = ${module}`] : []),
    "}",
  ];
}
