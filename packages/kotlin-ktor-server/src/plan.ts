import { metaStrings, type ExtensionRegistry, type FileSpec } from "@specgen/emitter-core";
import type { Program } from "@typespec/compiler";
import {
  camel,
  kotlinString,
  organizeImports,
  typeName,
  type KotlinIR,
  type KtService,
} from "@specgen/emitter-kotlin";
import { withContext, type ServerOperation } from "./context.js";
import type { KtorServerOptions } from "./options.js";
import { commonPrefix, routeTree, type RouteFunction } from "./routes.js";
import { resolveStyle, type RoutingStyle } from "./styles.js";
import { buildUnits, type ServerUnit } from "./units.js";

const SUPPORT_IMPORTS = [
  "io.ktor.server.application.ApplicationCall",
  "io.ktor.server.plugins.MissingRequestParameterException",
  "io.ktor.server.plugins.ParameterConversionException",
  "kotlinx.serialization.json.Json",
  "kotlinx.serialization.json.JsonPrimitive",
  "kotlinx.serialization.json.decodeFromJsonElement",
  "kotlinx.serialization.json.encodeToJsonElement",
];

/** `internal` helpers in ServerSupport.kt that routes in other packages must import. */
const SUPPORT_FUNCTIONS = [
  "convertParam",
  "cookieParam",
  "decodeParam",
  "encodeParam",
  "headerParam",
  "pathParam",
  "queryParam",
  "queryParams",
  "required",
];

const MODULE_IMPORTS = [
  "io.ktor.http.HttpStatusCode",
  "io.ktor.serialization.kotlinx.json.json",
  "io.ktor.server.application.Application",
  "io.ktor.server.application.install",
  "io.ktor.server.plugins.contentnegotiation.ContentNegotiation",
  "io.ktor.server.plugins.statuspages.StatusPages",
  "io.ktor.server.plugins.statuspages.StatusPagesConfig",
  "io.ktor.server.response.respond",
  "io.ktor.server.routing.Route",
  "io.ktor.server.routing.routing",
];

function typeImports(ops: ServerOperation[]): string[] {
  return ops.flatMap((op) => [
    ...op.params.flatMap((p) => p.type.imports),
    ...(op.body?.type.imports ?? []),
    ...op.result.type.imports,
    ...op.context.flatMap((c) => c.type.imports),
  ]);
}

export interface ServerOpExtras {
  annotations: string[];
  authenticate: string[];
  /** Full wrapper chain, outermost first: `authenticate(...)` from the `authenticate` key, then `wrap`. */
  wrap: string[];
  /** Extra imports for the routes file (`imports` key). */
  imports: string[];
  routeSet?: string;
}

function serverExtras(program: Program, units: ServerUnit[]): Record<string, ServerOpExtras> {
  const extras: Record<string, ServerOpExtras> = {};
  for (const unit of units) {
    for (const op of unit.operations) {
      const meta = op.meta["kotlin:ktor-server"] ?? {};
      const authenticate = metaStrings(program, meta, "authenticate", op.id);
      const [routeSet] = metaStrings(program, meta, "routeSet", op.id);
      extras[op.id] = {
        annotations: metaStrings(program, meta, "annotations", op.id),
        authenticate,
        // A wrapper declared both on the namespace and on the operation renders once.
        wrap: [
          ...new Set([
            ...(authenticate.length > 0 ? [`authenticate(${authenticate.map((a) => kotlinString(a)).join(", ")})`] : []),
            ...metaStrings(program, meta, "wrap", op.id),
          ]),
        ],
        imports: metaStrings(program, meta, "imports", op.id),
        ...(routeSet ? { routeSet } : {}),
      };
    }
  }
  return extras;
}

/** `wrap`, `routeSet` and `nest-routes` are dsl-only; other styles must not silently drop guards. */
function checkDslOnly(options: KtorServerOptions, units: ServerUnit[], extras: Record<string, ServerOpExtras>): void {
  if (options["routing-style"] === "dsl") return;
  const used =
    options["nest-routes"] ||
    units.some((u) =>
      u.operations.some((op) => {
        const e = extras[op.id];
        return e.routeSet !== undefined || e.wrap.length > (e.authenticate.length > 0 ? 1 : 0);
      }),
    );
  if (used) {
    throw new Error(`'wrap', 'routeSet' and 'nest-routes' need routing-style "dsl" (got "${options["routing-style"]}")`);
  }
}

function routeFunctions(
  unit: ServerUnit,
  options: KtorServerOptions,
  extras: Record<string, ServerOpExtras>,
): RouteFunction[] {
  // Keyed by the rendered name, so e.g. "unmanaged" and "Unmanaged" share one function.
  const sets = new Map<string, ServerOperation[]>();
  for (const op of unit.operations) {
    const set = extras[op.id].routeSet;
    const name = set === undefined ? "" : typeName(set);
    if (set !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`routeSet '${set}' of '${op.id}' yields no valid function name`);
    }
    sets.set(name, [...(sets.get(name) ?? []), op]);
  }
  if (sets.size === 0) return [{ name: unit.routesFn, nodes: [] }];
  return [...sets].map(([set, ops]) => {
    const prefix = options["nest-routes"] ? commonPrefix(ops.map((op) => op.path)) : "";
    return {
      name: set ? `${camel(unit.name)}${set}Routes` : unit.routesFn,
      ...(prefix ? { prefix } : {}),
      nodes: routeTree(ops.map((op) => ({ op, path: op.path.slice(prefix.length), chain: extras[op.id].wrap }))),
    };
  });
}

export function planServerFiles(
  ir: KotlinIR,
  options: KtorServerOptions,
  registry: ExtensionRegistry,
  program: Program,
): FileSpec[] {
  if (ir.services.length === 0) return [];
  const style = resolveStyle(options["routing-style"], registry);
  const supportPkg = options.package ?? `${ir.basePackage}.server`;
  const dirOf = (pkg: string) => `server/${pkg.replaceAll(".", "/")}`;
  const files: FileSpec[] = [
    {
      path: `${dirOf(supportPkg)}/ServerSupport.kt`,
      template: "kotlin/file",
      data: { package: supportPkg, imports: SUPPORT_IMPORTS, body: "ktor-server/support" },
    },
  ];
  for (const service of ir.services) {
    const units = buildUnits(service, options.grouping, options["service-suffix"]).map((unit) => ({
      ...unit,
      operations: unit.operations.map((op) => withContext(program, op, op.meta["kotlin:ktor-server"] ?? {})),
    }));
    const extras = serverExtras(program, units);
    checkDslOnly(options, units, extras);
    const functions = new Map(units.map((unit) => [unit, routeFunctions(unit, options, extras)]));
    for (const unit of units) {
      const pkg = unit.package ?? supportPkg;
      const support = pkg === supportPkg ? [] : SUPPORT_FUNCTIONS.map((f) => `${supportPkg}.${f}`);
      files.push(
        serviceFile(unit, pkg, dirOf(pkg), options, extras),
        routesFile(unit, pkg, dirOf(pkg), options, style, extras, support, functions.get(unit)!),
      );
    }
    if (options.module) files.push(moduleFile(ir, service, units, functions, supportPkg, dirOf(supportPkg), style));
  }
  return files;
}

function serviceFile(
  unit: ServerUnit,
  pkg: string,
  dir: string,
  options: KtorServerOptions,
  extras: Record<string, ServerOpExtras>,
): FileSpec {
  const imports = [
    ...typeImports(unit.operations),
    ...(options["call-access"] ? ["io.ktor.server.application.ApplicationCall"] : []),
  ];
  return {
    path: `${dir}/${unit.serviceName}.kt`,
    template: "kotlin/file",
    data: { package: pkg, imports: organizeImports(imports, pkg), body: "ktor-server/service", unit, options, extras },
  };
}

function routesFile(
  unit: ServerUnit,
  pkg: string,
  dir: string,
  options: KtorServerOptions,
  style: RoutingStyle,
  extras: Record<string, ServerOpExtras>,
  support: string[],
  functions: RouteFunction[],
): FileSpec {
  const imports = [
    ...typeImports(unit.operations),
    ...style.imports(unit, options),
    ...support,
    ...unit.operations.flatMap((op) => extras[op.id].imports),
    ...(unit.operations.some((op) => extras[op.id].authenticate.length > 0) ? ["io.ktor.server.auth.authenticate"] : []),
    ...(functions.some((f) => f.prefix) ? ["io.ktor.server.routing.route"] : []),
  ];
  return {
    path: `${dir}/${unit.name}Routes.kt`,
    template: "kotlin/file",
    data: {
      package: pkg,
      imports: organizeImports(imports, pkg),
      body: style.template,
      unit,
      options,
      extras,
      routeFunctions: functions,
    },
  };
}

function moduleFile(
  ir: KotlinIR,
  service: KtService,
  units: ServerUnit[],
  functions: Map<ServerUnit, RouteFunction[]>,
  pkg: string,
  dir: string,
  style: RoutingStyle,
): FileSpec {
  const exceptions = new Map<string, string>();
  for (const unit of units) {
    for (const op of unit.operations) {
      for (const error of op.errors) {
        if (error.exception.text !== "ApiException") exceptions.set(error.exception.imports[0], error.exception.text);
      }
    }
  }
  const installs = style.plugins ?? [];
  const unitImports = units
    .filter((u) => u.package && u.package !== pkg)
    .flatMap((u) => [`${u.package}.${u.serviceName}`, ...functions.get(u)!.map((f) => `${u.package}.${f.name}`)]);
  const imports = [...MODULE_IMPORTS, ...installs, ...exceptions.keys(), `${ir.apiPackage}.ApiException`, ...unitImports];
  const base = camel(service.name);
  return {
    path: `${dir}/${service.name}Module.kt`,
    template: "kotlin/file",
    data: {
      package: pkg,
      imports: organizeImports(imports, pkg),
      body: "ktor-server/module",
      service,
      units,
      /** Route function names per unit, in unit order. */
      mounts: units.map((u) => functions.get(u)!.map((f) => f.name)),
      installs,
      exceptions: [...exceptions.values()],
      moduleFn: `${base}Module`,
      apiRoutesFn: `${base}ApiRoutes`,
      errorsFn: `${base}Errors`,
    },
  };
}
