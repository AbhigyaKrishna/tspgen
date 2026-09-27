import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TSC = resolve(import.meta.dirname, "../../../node_modules/.bin/tsc");
const dirs: string[] = [];

/** Writes the .ts outputs into a new temp dir inside this package (so `zod` resolves from its node_modules). */
function write(outputs: Record<string, string>): string {
  const dir = mkdtempSync(join(resolve(import.meta.dirname, ".."), ".tmp-gen-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(outputs)) {
    if (!path.endsWith(".ts")) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

/** Runs strict tsc over the generated files; returns its output ("" = no errors). */
export function tsc(outputs: Record<string, string>, extra: Record<string, unknown> = {}): string {
  const dir = write(outputs);
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "es2022",
        module: "esnext",
        moduleResolution: "bundler",
        verbatimModuleSyntax: true,
        skipLibCheck: true,
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
}

/** Imports generated module `entry` (e.g. "types.ts") at runtime. */
export async function load(outputs: Record<string, string>, entry: string): Promise<Record<string, any>> {
  return import(pathToFileURL(join(write(outputs), entry)).href);
}

/** Removes every temp dir created so far (call from afterAll). */
export function cleanup(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}
