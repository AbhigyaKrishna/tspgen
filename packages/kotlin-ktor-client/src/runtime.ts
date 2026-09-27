import type { KotlinIR } from "@abhigyakrishna/tspgen-kotlin";
import type { KtorClientOptions } from "./options.js";

/** Settings of the generated client runtime code: features and flat options, resolved once. */
export interface ClientRuntime {
  ignoreUnknownKeys: boolean;
  encodeDefaults: boolean;
  auth: boolean;
  sseMaxSize: number;
}

export const DEFAULT_CLIENT_RUNTIME: ClientRuntime = {
  ignoreUnknownKeys: true,
  encodeDefaults: false,
  auth: true,
  sseMaxSize: 1048576,
};

/** `options.features` is filled with every default by core's loadTargets; the fallbacks cover direct callers. */
export function clientRuntime(options: KtorClientOptions): ClientRuntime {
  const features: Partial<KtorClientOptions["features"]> = options.features ?? {};
  return {
    ignoreUnknownKeys: features["ignore-unknown-keys"] ?? true,
    encodeDefaults: features["encode-defaults"] ?? false,
    auth: features.auth ?? true,
    sseMaxSize: options["sse-max-size"] ?? 1048576,
  };
}

/** The `<Service>Json` initializer: kotlinx's defaults with the features and the models' serializers. */
export function clientJsonExpr(ir: KotlinIR, runtime: ClientRuntime): string {
  const module = ir.serializersModule ? ir.serializersModule.slice(ir.serializersModule.lastIndexOf(".") + 1) : undefined;
  const settings = [
    ...(runtime.ignoreUnknownKeys ? ["ignoreUnknownKeys = true"] : []),
    ...(runtime.encodeDefaults ? ["encodeDefaults = true"] : []),
    ...(module ? [`serializersModule = ${module}`] : []),
  ];
  return settings.length === 0 ? "Json" : ["Json {", ...settings.map((s) => `    ${s}`), "}"].join("\n");
}
