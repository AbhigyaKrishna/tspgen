import { emitFile, resolvePath, type Program } from "@typespec/compiler";

export const MANIFEST_FILE = ".generated-manifest.json";

export interface OutputFile {
  /** Path relative to the output dir, posix separators. */
  path: string;
  content: string;
}

interface ManifestEntry {
  files: string[];
  /** Other directories this emitter wrote to (relative to the manifest's directory, posix). */
  outputDirs?: string[];
}

/**
 * `.generated-manifest.json`: `files` lists everything generated in the directory; `owners` keeps each
 * emitter's own list, so emitters sharing a directory only ever delete their own stale files.
 */
interface Manifest {
  files: string[];
  owners?: Record<string, ManifestEntry>;
}

export interface WriteOptions {
  /** Emitter (language) writing the files; manifests keep one entry per owner. */
  owner?: string;
  /** Directories other than `outputDir` the owner wrote to, recorded so they can be cleaned up later. */
  outputDirs?: string[];
}

/**
 * Write files, delete files the same owner listed in the previous manifest that are no longer produced.
 * Returns the owner's previous entry.
 */
export async function writeOutputs(
  program: Program,
  outputDir: string,
  files: readonly OutputFile[],
  options: WriteOptions = {},
): Promise<ManifestEntry> {
  const owner = options.owner ?? "";
  const manifest = await readManifest(program, outputDir);
  // A manifest without owners was written by 0.1.2 or earlier for a single emitter: it belongs to whoever writes next.
  const previous: ManifestEntry = manifest.owners ? (manifest.owners[owner] ?? { files: [] }) : { files: manifest.files };
  if (program.compilerOptions.noEmit) return previous;
  const others = Object.entries(manifest.owners ?? {}).filter(([name]) => name !== owner);
  if (files.length === 0 && previous.files.length === 0 && !options.outputDirs?.length) return previous;
  const current = files.map((f) => f.path).sort();
  for (const file of files) {
    await emitFile(program, { path: resolvePath(outputDir, file.path), content: file.content });
  }
  const keep = new Set([...current, ...others.flatMap(([, entry]) => entry.files)]);
  for (const stale of previous.files) {
    if (keep.has(stale) || !isSafeRelative(stale)) continue;
    await program.host.rm(resolvePath(outputDir, stale), { recursive: false }).catch(() => {});
  }
  const entry: ManifestEntry = { files: current, ...(options.outputDirs?.length ? { outputDirs: options.outputDirs } : {}) };
  const owners = Object.fromEntries(
    [...others, [owner, entry] as const]
      .filter(([, e]) => e.files.length > 0 || e.outputDirs?.length)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const all = [...new Set(Object.values(owners).flatMap((e) => e.files))].sort();
  const path = resolvePath(outputDir, MANIFEST_FILE);
  if (Object.keys(owners).length === 0) {
    await program.host.rm(path, { recursive: false }).catch(() => {});
  } else if (options.owner === undefined && !manifest.owners) {
    await emitFile(program, { path, content: JSON.stringify({ files: all }, null, 2) + "\n" });
  } else {
    await emitFile(program, { path, content: JSON.stringify({ files: all, owners }, null, 2) + "\n" });
  }
  return previous;
}

async function readManifest(program: Program, outputDir: string): Promise<Manifest> {
  const strings = (list: unknown) => (Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
  try {
    const file = await program.host.readFile(resolvePath(outputDir, MANIFEST_FILE));
    const parsed = JSON.parse(file.text) as { files?: unknown; owners?: unknown };
    const manifest: Manifest = { files: strings(parsed.files) };
    if (parsed.owners && typeof parsed.owners === "object") {
      manifest.owners = Object.fromEntries(
        Object.entries(parsed.owners as Record<string, { files?: unknown; outputDirs?: unknown }>).map(([name, e]) => [
          name,
          { files: strings(e?.files), ...(Array.isArray(e?.outputDirs) ? { outputDirs: strings(e.outputDirs) } : {}) },
        ]),
      );
    }
    return manifest;
  } catch {
    return { files: [] };
  }
}

function isSafeRelative(path: string): boolean {
  return !path.startsWith("/") && !/^[A-Za-z]:/.test(path) && !path.split(/[\\/]/).includes("..");
}

/** Directory path without trailing separators (keeping a root), so equal directories compare equal. */
export function normalizeDir(dir: string): string {
  return dir.replace(/(?<=[^\\/:])[\\/]+$/, "");
}
