import type { FileSpec } from "../targets/target.js";
import type { ExtensionRegistry } from "./registry.js";

export interface PluginContext {
  language: string;
  options: Record<string, unknown>;
  registry: ExtensionRegistry;
}

export interface TspGenPlugin<L = unknown> {
  name: string;
  /** Restrict to these languages; all languages when omitted. */
  languages?: string[];
  setup?(ctx: PluginContext): void;
  /** Mutate the language IR in place or return a replacement. */
  transformIR?(ir: L, ctx: PluginContext): L | void;
  /** Mutate the planned files in place or return a replacement list. */
  files?(files: FileSpec[], ir: L, ctx: PluginContext): FileSpec[] | void;
  /** Template directory (path or file URL) layered above targets and the language. */
  templates?: string | URL;
  helpers?: Record<string, unknown>;
}

export function definePlugin<L = unknown>(plugin: TspGenPlugin<L>): TspGenPlugin<L> {
  return plugin;
}
