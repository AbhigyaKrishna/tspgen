import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Import a module's default export. Relative/absolute paths resolve against `baseDir`; bare
 * specifiers resolve from `baseDir`'s node_modules (the user's project, not this package).
 */
export async function loadModuleDefault<T>(specifier: string, baseDir: string): Promise<T> {
  const path =
    specifier.startsWith(".") || isAbsolute(specifier)
      ? resolve(baseDir, specifier)
      : createRequire(resolve(baseDir, "package.json")).resolve(specifier);
  const mod: Record<string, unknown> = await import(pathToFileURL(path).href);
  if (!("default" in mod)) throw new Error(`Module '${specifier}' has no default export`);
  return mod.default as T;
}
