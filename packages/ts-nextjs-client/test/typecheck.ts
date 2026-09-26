import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const TSC = resolve(import.meta.dirname, "../../../node_modules/.bin/tsc");

/**
 * Writes generated .ts files into a temp dir inside this package (so zod/react/@tanstack resolve
 * from its node_modules), runs `tsc --strict`, removes the dir and returns tsc's output ("" = ok).
 */
export function typecheck(outputs: Record<string, string>, extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(resolve(import.meta.dirname, ".."), ".tmp-tsc-"));
  try {
    for (const [path, content] of Object.entries(outputs)) {
      if (!path.endsWith(".ts")) continue;
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "es2022",
          lib: ["es2022", "dom"],
          module: "esnext",
          moduleResolution: "bundler",
          verbatimModuleSyntax: true,
          skipLibCheck: true,
          types: [],
          ...extra,
        },
        include: ["**/*.ts"],
      }),
    );
    try {
      return execFileSync(TSC, ["-p", dir], { encoding: "utf8" });
    } catch (error) {
      return String((error as { stdout?: string }).stdout ?? error);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
