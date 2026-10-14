import type { FileSpec, TargetContext } from "@abhigyakrishna/tspgen-core";
import {
  propertyKey,
  renderImports,
  reportDiagnostic,
  type TsImport,
  type TsIR,
  type TsOperation,
  type TsTypeUse,
} from "@abhigyakrishna/tspgen-typescript";
import { NoTarget } from "@typespec/compiler";
import { nextjsHelpers } from "./helpers.js";
import { names } from "./names.js";
import type { NextClientOptions } from "./options.js";

function responseUses(op: TsOperation): TsTypeUse[] {
  if (op.result.kind === "single") return [op.result.stream?.type ?? op.result.type];
  return op.result.decl.variants.flatMap((v) => [...(v.body ? [v.body] : []), ...v.headers.map((h) => h.type)]);
}

function responseSchema(op: TsOperation): string {
  if (op.result.kind === "single") return (op.result.stream?.type ?? op.result.type).effectSchema!;
  const variants = op.result.decl.variants.map((v) => {
    const fields = [`status: ${v.status === undefined ? "Schema.Number" : `Schema.Literal(${v.status})`}`];
    if (v.body) fields.push(`body: ${v.body.effectSchema}`);
    if (v.headers.length) {
      const headers = v.headers.map(
        (h) =>
          `${propertyKey(h.name)}: ${h.optional ? `Schema.optionalKey(${h.type.effectSchema})` : h.type.effectSchema}`,
      );
      fields.push(`headers: Schema.Struct({ ${headers.join(", ")} })`);
    }
    return `Schema.Struct({ ${fields.join(", ")} })`;
  });
  return `Schema.Union([${variants.join(", ")}])`;
}

function checkClientNames(ir: TsIR, imports: TsImport[], ctx: TargetContext): void {
  const exportedNames = new Set([
    "EffectClientError",
    ...ir.services.flatMap((s) => [`${s.name}EffectClient`, `create${s.name}EffectClient`]),
  ]);
  const collisions = new Set<string>();
  for (const decl of ir.declarations) {
    const names = decl.kind === "enum" && decl.values ? [decl.name, decl.values] : [decl.name];
    for (const name of names) if (exportedNames.has(name)) collisions.add(name);
  }
  const owners = new Map<string, string>(
    [...exportedNames, "toEffectError", "withSignal", "effectMethod", "streamMethod", "abortableIterable"].map(
      (name) => [name, "the Effect client"],
    ),
  );
  for (const imported of imports) {
    const owner = `${imported.root ?? ""}:${imported.from}`;
    const first = owners.get(imported.name);
    if (first !== undefined && first !== owner) collisions.add(imported.name);
    owners.set(imported.name, owner);
  }
  for (const name of collisions) {
    reportDiagnostic(ctx.program, { code: "effect-client-name-clash", format: { name }, target: NoTarget });
  }
}

/** A companion facade reuses the fetch client, including auth, uploads, wire encoding and status handling. */
export function planEffectFile(
  ir: TsIR & { modelsPrefix?: string },
  options: NextClientOptions,
  ctx: TargetContext,
): FileSpec {
  const flat = options["client-style"] === "flat";
  const path = flat ? "effect" : "client/effect";
  const error = flat
    ? (options["error-class"] ?? `${ir.services.find((s) => s.groups.length)?.name}Error`)
    : "HttpError";
  const services = ir.services.filter((s) => s.groups.length);
  const operations = services.flatMap((s) => s.groups.flatMap((g) => g.operations));
  const streams = operations.some(nextjsHelpers.isStream);
  const imports: TsImport[] = [
    ...["Data", "Effect", ...(streams ? ["Stream"] : []), ...(ir.effect ? ["Schema"] : [])].map((name) => ({
      name,
      from: "effect",
      typeOnly: false,
      external: true,
    })),
    { name: "RequestOptions", from: flat ? "client" : "client/core", typeOnly: true },
    {
      name: error,
      from: flat ? "client" : "api/errors",
      typeOnly: false,
      ...(flat ? {} : { root: "models" as const }),
    },
    ...services.map((s) => ({
      name: flat ? `${s.name}Client` : names.apiClient(s),
      from: flat ? "client" : "client/index",
      typeOnly: false,
    })),
    ...(ir.effect ? operations.flatMap(responseUses).flatMap((t) => t.effectImports ?? []) : []),
  ];
  checkClientNames(ir, imports, ctx);
  return {
    path: `${path}.ts`,
    template: "ts/file",
    data: {
      imports: renderImports(path, imports, ir.importExtension, ir.modelsPrefix),
      body: "ts-nextjs/effect-client",
      flat,
      error,
      streams,
      schemas: ir.effect,
      services,
      clientName: (name: string) => (flat ? `${name}Client` : `${name}ApiClient`),
      optionsIndex: (op: TsOperation) =>
        flat
          ? op.params.filter((p) => p.location === "path").length +
            Number(op.body !== undefined) +
            Number(op.params.some((p) => p.location === "query"))
          : Number(nextjsHelpers.hasParams(op)),
      responseSchema,
    },
  };
}
