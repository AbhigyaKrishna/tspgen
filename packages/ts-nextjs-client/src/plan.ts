import { metaNumber, metaObject, type FileSpec, type TargetContext } from "@specgen/emitter-core";
import { reportDiagnostic } from "@specgen/emitter-typescript";
import { NoTarget } from "@typespec/compiler";
import {
  relativeSpecifier,
  renderImports,
  type TsGroup,
  type TsImport,
  type TsIR,
  type TsOperation,
  type TsService,
} from "@specgen/emitter-typescript";
import { planFlatFiles } from "./flat.js";
import { nextjsHelpers as h } from "./helpers.js";
import { names } from "./names.js";
import type { NextClientOptions } from "./options.js";

const CORE = "client/core";
const Z: TsImport = { name: "z", from: "zod", typeOnly: false, external: true };

const value = (name: string, from: string): TsImport => ({ name, from, typeOnly: false });
const type = (name: string, from: string): TsImport => ({ name, from, typeOnly: true });

function file(path: string, ir: TsIR, imports: TsImport[], body: string, data: Record<string, unknown> = {}, directive?: string): FileSpec {
  return {
    path: `${path}.ts`,
    template: "ts/file",
    data: {
      imports: renderImports(path, imports, ir.importExtension),
      body,
      zod: ir.zod,
      ...(directive ? { directive } : {}),
      ...data,
    },
  };
}

function groupImports(ir: TsIR, g: TsGroup): TsImport[] {
  const ops = g.operations;
  const results = ops.map((op) => op.result);
  const variants = results.flatMap((r) => (r.kind === "union" ? r.decl.variants : []));
  const headers = variants.flatMap((v) => v.headers);
  const bodies = [
    ...results.flatMap((r) => (r.kind === "single" && r.type.text !== "void" ? [r.type] : [])),
    ...variants.flatMap((v) => (v.body ? [v.body] : [])),
  ];
  const fields = ops.flatMap((op) => h.fields(op).map((f) => f.type));
  return [
    type("ClientConfig", CORE),
    type("RequestOptions", CORE),
    value("request", CORE),
    value("toError", CORE),
    ...(bodies.length > 0 ? [value("parse", CORE)] : []),
    ...(headers.some((x) => !x.optional) ? [value("requireHeader", CORE)] : []),
    ...(headers.some((x) => x.optional) ? [value("optionalHeader", CORE)] : []),
    ...ops.flatMap((op) => op.errors.flatMap((e) => [...e.errorClass.imports, ...(e.body?.imports ?? [])])),
    ...results.flatMap((r) => r.type.imports),
    ...headers.flatMap((x) => x.type.imports),
    ...fields.flatMap((t) => t.imports),
    ...(ir.zod ? [Z, ...fields.flatMap((t) => t.schemaImports), ...bodies.flatMap((t) => t.schemaImports)] : []),
    ...bodies.flatMap((t) => t.imports),
  ];
}

export interface NextOpExtras {
  next?: Record<string, unknown>;
  staleTime?: number;
}

function nextExtras(ctx: TargetContext, groups: TsGroup[]): Record<string, NextOpExtras> {
  const extras: Record<string, NextOpExtras> = {};
  for (const g of groups) {
    for (const op of g.operations) {
      const meta = op.meta["typescript:ts-nextjs-client"] ?? {};
      const next = metaObject(ctx.program, meta, "next", op.id);
      const staleTime = metaNumber(ctx.program, meta, "staleTime", op.id);
      extras[op.id] = { ...(next ? { next } : {}), ...(staleTime !== undefined ? { staleTime } : {}) };
    }
  }
  return extras;
}

export function planNextFiles(ir: TsIR, options: NextClientOptions, ctx: TargetContext): FileSpec[] {
  if (options["client-style"] === "flat") return planFlatFiles(ir, options, ctx);
  const services = ir.services.filter((s) => s.groups.length > 0);
  if (services.length === 0) return [];
  const groups = services.flatMap((s) => s.groups);
  const extras = nextExtras(ctx, groups);
  for (const g of groups) {
    for (const op of g.operations) {
      if (!h.isJson(op)) {
        reportDiagnostic(ctx.program, {
          code: "non-json-body",
          format: { operation: op.id, contentType: op.body!.contentType },
          target: NoTarget,
        });
      }
    }
  }
  const files: FileSpec[] = [file(CORE, ir, [value("HttpError", "api/errors")], "ts-nextjs/core")];
  for (const g of groups) {
    files.push(file(names.groupFile(g), ir, groupImports(ir, g), "ts-nextjs/group", { group: g, extras }));
  }
  files.push(
    file(
      "client/index",
      ir,
      [type("ClientConfig", CORE), ...groups.map((g) => value(names.groupClass(g), names.groupFile(g)))],
      "ts-nextjs/index",
      { services, exports: [CORE, ...groups.map(names.groupFile)].map((f) => relativeSpecifier("client/index", f, ir.importExtension)) },
    ),
  );
  if (options["react-query"] ?? true) files.push(...reactQueryFiles(ir, services, extras));
  if (options["server-actions"] ?? true) files.push(...actionFiles(ir, services, options));
  return files;
}

const QUERIES = "client/react-query/queries";
const HOOKS = "client/react-query/hooks";

function paramsImports(g: TsGroup, ops: TsOperation[]): TsImport[] {
  return ops.filter(h.hasParams).map((op) => type(names.params(g, op), names.groupFile(g)));
}

function reactQueryFiles(ir: TsIR, services: TsService[], extras: Record<string, NextOpExtras>): FileSpec[] {
  const queryOps = (g: TsGroup) => g.operations.filter((op) => h.isQuery(op) && h.isJson(op));
  const mutationOps = (g: TsGroup) => g.operations.filter((op) => !h.isQuery(op) && h.isJson(op));
  const groups = services.flatMap((s) => s.groups);
  const queries = file(
    QUERIES,
    ir,
    [
      { name: "queryOptions", from: "@tanstack/react-query", typeOnly: false, external: true },
      ...services.map((s) => type(names.apiClient(s), "client/index")),
      ...groups.flatMap((g) => paramsImports(g, queryOps(g))),
    ],
    "ts-nextjs/queries",
    { services, queryOps, extras },
  );
  const hooks = file(
    HOOKS,
    ir,
    [
      { name: "useMutation", from: "@tanstack/react-query", typeOnly: false, external: true },
      { name: "useQuery", from: "@tanstack/react-query", typeOnly: false, external: true },
      { name: "UseMutationOptions", from: "@tanstack/react-query", typeOnly: true, external: true },
      { name: "UseQueryOptions", from: "@tanstack/react-query", typeOnly: true, external: true },
      { name: "createContext", from: "react", typeOnly: false, external: true },
      { name: "createElement", from: "react", typeOnly: false, external: true },
      { name: "useContext", from: "react", typeOnly: false, external: true },
      { name: "ReactNode", from: "react", typeOnly: true, external: true },
      ...services.map((s) => type(names.apiClient(s), "client/index")),
      ...services.flatMap((s) => [value(names.keys(s), QUERIES), value(names.queries(s), QUERIES)]),
      ...groups.flatMap((g) => [...paramsImports(g, queryOps(g)), ...paramsImports(g, mutationOps(g))]),
      ...groups.flatMap((g) => [...queryOps(g), ...mutationOps(g)].flatMap((op) => op.result.type.imports)),
    ],
    "ts-nextjs/hooks",
    { services, queryOps, mutationOps },
    "use client",
  );
  return [queries, hooks];
}

const RESULT = "client/actions/result";
const SERVER_CLIENT = "client/actions/server-client";

function actionFiles(ir: TsIR, services: TsService[], options: NextClientOptions): FileSpec[] {
  const actionOps = (g: TsGroup) => g.operations.filter((op) => !h.isQuery(op) && h.isJson(op));
  const files: FileSpec[] = [
    file(RESULT, ir, [value("HttpError", "api/errors")], "ts-nextjs/action-result"),
    file(
      SERVER_CLIENT,
      ir,
      [type("ClientConfig", CORE), ...services.map((s) => value(names.apiClient(s), "client/index"))],
      "ts-nextjs/server-client",
      { services, env: options["base-url-env"] },
    ),
  ];
  for (const s of services) {
    for (const g of s.groups) {
      const ops = actionOps(g);
      if (ops.length === 0) continue;
      files.push(
        file(
          names.actionsFile(g),
          ir,
          [
            value(names.serverClient(s), SERVER_CLIENT),
            value("runAction", RESULT),
            type("ActionResult", RESULT),
            ...paramsImports(g, ops),
            ...(ir.zod ? ops.filter(h.hasParams).map((op) => value(`${names.params(g, op)}Schema`, names.groupFile(g))) : []),
            ...ops.flatMap((op) => op.result.type.imports),
          ],
          "ts-nextjs/actions",
          { service: s, group: g, operations: ops },
          "use server",
        ),
      );
    }
  }
  return files;
}

export type { TsOperation, TsService };
