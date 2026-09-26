import { NoTarget, type Program } from "@typespec/compiler";
import { errorMessage, reportDiagnostic } from "../lib.js";
import { loadModuleDefault } from "../loader.js";
import type { TspGenPlugin } from "./plugin.js";

/** Load plugins in order; reports a diagnostic and returns undefined on the first failure. */
export async function loadPlugins(
  program: Program,
  specifiers: readonly string[],
  baseDir: string,
): Promise<TspGenPlugin[] | undefined> {
  const plugins: TspGenPlugin[] = [];
  for (const specifier of specifiers) {
    try {
      const plugin = await loadModuleDefault<TspGenPlugin>(specifier, baseDir);
      if (!plugin || typeof plugin.name !== "string") {
        throw new Error("default export is not a tspgen plugin (missing 'name')");
      }
      plugins.push(plugin);
    } catch (error) {
      reportDiagnostic(program, {
        code: "module-load-failed",
        format: { kind: "plugin", specifier, message: errorMessage(error) },
        target: NoTarget,
      });
      return undefined;
    }
  }
  return plugins;
}
