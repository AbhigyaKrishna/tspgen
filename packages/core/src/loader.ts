import { createRequire } from "node:module";
import { extname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TYPESCRIPT = new Set([".ts", ".mts", ".cts"]);

/** Node's built-in type stripping: "strip" | "transform" when available (Node >= 22.18 / 23.6), else false. */
function nodeTypeScript(): string | false {
  return (process.features as { typescript?: string | false }).typescript ?? false;
}

/**
 * Import a module's default export. Relative/absolute paths resolve against `baseDir`; bare
 * specifiers resolve from `baseDir`'s node_modules (the user's project, not this package).
 *
 * TypeScript modules (`.ts`, `.mts`, `.cts`) load through Node's built-in type stripping, so they
 * are limited to erasable syntax (TypeScript's `erasableSyntaxOnly`): no `enum`, `namespace` or
 * parameter properties, and relative imports spell out the `.ts` extension.
 */
export async function loadModuleDefault<T>(specifier: string, baseDir: string): Promise<T> {
  const path =
    specifier.startsWith(".") || isAbsolute(specifier)
      ? resolve(baseDir, specifier)
      : createRequire(resolve(baseDir, "package.json")).resolve(specifier);
  const typescript = TYPESCRIPT.has(extname(path));
  if (typescript && !nodeTypeScript()) {
    throw new Error(
      `'${specifier}' is TypeScript, which needs Node's type stripping (Node >= 22.18 or 23.6; running ${process.version})`,
    );
  }
  let mod: Record<string, unknown>;
  try {
    mod = await import(pathToFileURL(path).href);
  } catch (error) {
    if (typescript && (error as { code?: string }).code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") {
      throw new Error(
        `'${specifier}' uses TypeScript syntax that Node cannot strip (enum, namespace, parameter properties); ` +
          `keep to erasable syntax (tsconfig "erasableSyntaxOnly"): ${(error as Error).message}`,
      );
    }
    throw error;
  }
  if (!("default" in mod)) throw new Error(`Module '${specifier}' has no default export`);
  return mod.default as T;
}
