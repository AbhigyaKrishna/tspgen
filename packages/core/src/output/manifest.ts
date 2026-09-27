import { emitFile, resolvePath, type Program } from "@typespec/compiler";

export const MANIFEST_FILE = ".generated-manifest.json";

export interface OutputFile {
  /** Path relative to the output dir, posix separators. */
  path: string;
  content: string;
}

/** Write files, delete files listed in the previous manifest that are no longer produced. */
export async function writeOutputs(program: Program, outputDir: string, files: readonly OutputFile[]): Promise<void> {
  if (program.compilerOptions.noEmit) return;
  const previous = await readManifest(program, outputDir);
  if (files.length === 0 && previous.length === 0) return;
  const current = files.map((f) => f.path).sort();
  for (const file of files) {
    await emitFile(program, { path: resolvePath(outputDir, file.path), content: file.content });
  }
  const keep = new Set(current);
  for (const stale of previous) {
    if (keep.has(stale) || !isSafeRelative(stale)) continue;
    await program.host.rm(resolvePath(outputDir, stale), { recursive: false }).catch(() => {});
  }
  await emitFile(program, {
    path: resolvePath(outputDir, MANIFEST_FILE),
    content: JSON.stringify({ files: current }, null, 2) + "\n",
  });
}

async function readManifest(program: Program, outputDir: string): Promise<string[]> {
  try {
    const file = await program.host.readFile(resolvePath(outputDir, MANIFEST_FILE));
    const parsed: unknown = JSON.parse(file.text);
    const list = (parsed as { files?: unknown }).files;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function isSafeRelative(path: string): boolean {
  return !path.startsWith("/") && !/^[A-Za-z]:/.test(path) && !path.split(/[\\/]/).includes("..");
}

/** Directory path without trailing separators (keeping a root), so equal directories compare equal. */
export function normalizeDir(dir: string): string {
  return dir.replace(/(?<=[^\\/:])[\\/]+$/, "");
}
