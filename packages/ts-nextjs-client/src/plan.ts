import type { FileSpec, TargetContext } from "@abhigyakrishna/tspgen-core";
import { reportDiagnostic } from "@abhigyakrishna/tspgen-typescript";
import { NoTarget } from "@typespec/compiler";
import {
  modelsPrefix,
  relativeSpecifier,
  renderImports,
  type TsGroup,
  type TsImport,
  type TsIR,
  type TsOperation,
  type TsService,
} from "@abhigyakrishna/tspgen-typescript";
import { clientAuth, type ClientAuth } from "./auth.js";
import { nextExtras, type NextOpExtras } from "./extras.js";
import { planFlatFiles } from "./flat.js";
import { nextjsHelpers as h } from "./helpers.js";
import { names } from "./names.js";
import type { NextClientOptions } from "./options.js";

const CORE = "client/core";
const Z: TsImport = { name: "z", from: "zod", typeOnly: false, external: true };

const value = (name: string, from: string): TsImport => ({ name, from, typeOnly: false });
const HTTP_ERROR_IMPORT: TsImport = { name: "HttpError", from: "api/errors", typeOnly: false, root: "models" };
const type = (name: string, from: string): TsImport => ({ name, from, typeOnly: true });

/** TsIR plus the path from this target's output dir to the models output dir (see `modelsPrefix`). */
type PlanIR = TsIR & { modelsPrefix?: string };

function file(path: string, ir: PlanIR, imports: TsImport[], body: string, data: Record<string, unknown> = {}, directive?: string): FileSpec {
  return {
    path: `${path}.ts`,
    template: "ts/file",
    data: {
      imports: renderImports(path, imports, ir.importExtension, ir.modelsPrefix),
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
  const streams = results.flatMap((r) => (r.kind === "single" && r.stream ? [r.stream] : []));
  const bodies = [
    ...results.flatMap((r) => (r.kind === "single" && r.type.text !== "void" && !r.stream ? [r.type] : [])),
    ...variants.flatMap((v) => (v.body ? [v.body] : [])),
  ];
  const fields = ops.flatMap((op) => h.fields(op).map((f) => f.type));
  return [
    type("ClientConfig", CORE),
    type("RequestOptions", CORE),
    value("request", CORE),
    value("toError", CORE),
    ...(bodies.length > 0 ? [value("parse", CORE)] : []),
    ...(streams.length > 0 ? [value("streamEvents", CORE)] : []),
    ...(headers.some((x) => !x.optional) ? [value("requireHeader", CORE)] : []),
    ...(headers.some((x) => x.optional) ? [value("optionalHeader", CORE), value("optionalEntry", CORE)] : []),
    ...ops.flatMap((op) => op.errors.flatMap((e) => [...e.errorClass.imports, ...(e.body?.imports ?? [])])),
    ...results.flatMap((r) => r.type.imports),
    ...headers.flatMap((x) => x.type.imports),
    ...fields.flatMap((t) => t.imports),
    ...(ir.zod
      ? [
          Z,
          ...fields.flatMap((t) => t.schemaImports),
          ...bodies.flatMap((t) => t.schemaImports),
          ...streams.flatMap((t) => (t.events ? t.type.schemaImports : [])),
        ]
      : []),
    ...bodies.flatMap((t) => t.imports),
  ];
}

export function planNextFiles(tsIR: TsIR, options: NextClientOptions, ctx: TargetContext): FileSpec[] {
  const ir: PlanIR = { ...tsIR, modelsPrefix: modelsPrefix(ctx.outputDir, ctx.modelsOutputDir) };
  if (options["client-style"] === "flat") return planFlatFiles(ir, options, ctx);
  if (options.validate === true) reportDiagnostic(ctx.program, { code: "validate-flat-only", target: NoTarget });
  const services = ir.services.filter((s) => s.groups.length > 0);
  if (services.length === 0) return [];
  const groups = services.flatMap((s) => s.groups);
  const extras = nextExtras(ctx, groups);
  for (const g of groups) {
    for (const op of g.operations) {
      if (op.body && !h.isJson(op) && !h.isUpload(op)) {
        reportDiagnostic(ctx.program, {
          code: "non-json-body",
          format: { operation: op.id, contentType: op.body!.contentType },
          target: NoTarget,
        });
      }
    }
  }
  const actions = options["server-actions"] ?? true;
  // Server Actions validate their input without undefined-valued keys.
  const withoutUndefined = ir.zod && actions && groups.some((g) => actionOps(g).some(h.hasParams));
  // PartSpec, toFormData and the multipart/file request branches only when an operation uploads.
  const uploads = groups.some((g) => g.operations.some(h.isUpload));
  // EventSpec, readEvents and streamEvents only when an operation streams server-sent events.
  const streams = groups.some((g) => g.operations.some(h.isStream));
  // Services using @useAuth schemes the client can send, by service id; the auth runtime only when there is one.
  const auth: Record<string, ClientAuth> = {};
  for (const s of services) {
    const found = clientAuth(ctx.program, s, "the Next.js client");
    if (found) auth[s.id] = found;
  }
  const auths = Object.values(auth);
  const files: FileSpec[] = [
    file(CORE, ir, [HTTP_ERROR_IMPORT], "ts-nextjs/core", { withoutUndefined, uploads, streams, auth: auths.length > 0 }),
  ];
  for (const s of services) {
    for (const g of s.groups) {
      files.push(file(names.groupFile(g), ir, groupImports(ir, g), "ts-nextjs/group", { group: g, extras, auth: auth[s.id] }));
    }
  }
  files.push(
    file(
      "client/index",
      ir,
      [
        type("ClientConfig", CORE),
        ...(auths.length > 0 ? [type("AuthProvider", CORE)] : []),
        ...(auths.some((a) => a.basic) ? [type("BasicCredentials", CORE)] : []),
        ...groups.map((g) => value(names.groupClass(g), names.groupFile(g))),
      ],
      "ts-nextjs/index",
      {
        services,
        auth,
        exports: [CORE, ...groups.map(names.groupFile)].map((f) => relativeSpecifier("client/index", f, ir.importExtension)),
      },
    ),
  );
  if (options["react-query"] ?? true) files.push(...reactQueryFiles(ir, services, extras));
  if (actions) files.push(...actionFiles(ir, services, options, auth));
  return files;
}

const QUERIES = "client/react-query/queries";
const HOOKS = "client/react-query/hooks";

function paramsImports(g: TsGroup, ops: TsOperation[]): TsImport[] {
  return ops.filter(h.hasParams).map((op) => type(names.params(g, op), names.groupFile(g)));
}

function reactQueryFiles(ir: TsIR, services: TsService[], extras: Record<string, NextOpExtras>): FileSpec[] {
  const queryOps = (g: TsGroup) => g.operations.filter((op) => h.isQuery(op) && h.isHookable(op));
  const mutationOps = (g: TsGroup) => g.operations.filter((op) => !h.isQuery(op) && h.isHookable(op));
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

const actionOps = (g: TsGroup) => g.operations.filter((op) => !h.isQuery(op) && h.isHookable(op));

function actionFiles(ir: TsIR, services: TsService[], options: NextClientOptions, auth: Record<string, ClientAuth>): FileSpec[] {
  const files: FileSpec[] = [
    file(RESULT, ir, [HTTP_ERROR_IMPORT], "ts-nextjs/action-result"),
    file(
      SERVER_CLIENT,
      ir,
      [
        type("ClientConfig", CORE),
        ...services.map((s) => value(names.apiClient(s), "client/index")),
        ...services.filter((s) => auth[s.id]).map((s) => type(names.auth(s), "client/index")),
      ],
      "ts-nextjs/server-client",
      { services, env: options["base-url-env"], auth },
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
            ...(ir.zod && ops.some(h.hasParams) ? [value("withoutUndefined", CORE)] : []),
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

export type { NextOpExtras, TsOperation, TsService };
