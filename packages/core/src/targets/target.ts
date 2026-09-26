import type { Program } from "@typespec/compiler";
import type { ApiIR } from "../ir/types.js";
import type { ExtensionRegistry } from "../plugins/registry.js";

/** One output file: rendered from `template` (logical name) with `data`. `path` is relative, posix. */
export interface FileSpec {
  path: string;
  template: string;
  data: Record<string, unknown>;
  /**
   * Absolute directory `path` is relative to. Filled by the pipeline with the producing target's
   * output dir (the emitter output dir for files added by plugins) when absent.
   */
  outputDir?: string;
}

export interface LanguageContext {
  program: Program;
  options: Record<string, unknown>;
}

/** A language: maps ApiIR to its own IR and provides base templates/helpers. */
export interface LanguageModule<L = unknown> {
  name: string;
  /** Absolute path of the language's template directory (lowest-priority layer). */
  templates: string;
  helpers?: Record<string, unknown>;
  transform(ir: ApiIR, ctx: LanguageContext): L;
  format?(path: string, content: string): string | Promise<string>;
}

export interface TargetContext {
  program: Program;
  language: string;
  emitterOptions: Record<string, unknown>;
  options: Record<string, unknown>;
  registry: ExtensionRegistry;
  /** Absolute directory this target's files are written to (its `output-dir`, else the emitter output dir). */
  outputDir: string;
  /** Absolute directory of the built-in models target's files. */
  modelsOutputDir: string;
}

/** A server or client library (or the language's shared models) producing files from language IR. */
export interface Target<L = unknown> {
  name: string;
  kind: "models" | "server" | "client";
  language: string;
  templates?: string;
  helpers?: Record<string, unknown>;
  /** JSON schema for this target's options; defaults declared in it are applied. */
  optionsSchema?: object;
  files(ir: L, ctx: TargetContext): FileSpec[];
}
