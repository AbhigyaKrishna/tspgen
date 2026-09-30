import type { FileSpec, TargetContext } from "@abhigyakrishna/tspgen-core";
import { modelsDirectory } from "./layout.js";
import type { GoHTTPOptions } from "../options.js";
import { localModuleVersion, type GoIR } from "../transform.js";

export function httpModuleFile(
  kind: "client" | "server",
  ir: GoIR,
  ctx: TargetContext,
  options: GoHTTPOptions,
  version: string,
  template = "go/dependent-mod",
): FileSpec {
  return {
    path: `${kind}/go.mod`,
    template,
    data: {
      module: options.module,
      goVersion: version,
      modelsModule: ir.module,
      modelsVersion: localModuleVersion(ir.module),
      modelsDir: modelsDirectory(ctx, kind),
    },
  };
}
