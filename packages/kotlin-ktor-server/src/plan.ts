import type { ExtensionRegistry, FileSpec } from "@specgen/emitter-core";
import { camel, organizeImports, type KotlinIR, type KtOperation, type KtService } from "@specgen/emitter-kotlin";
import type { KtorServerOptions } from "./options.js";
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

function typeImports(ops: KtOperation[]): string[] {
  return ops.flatMap((op) => [
    ...op.params.flatMap((p) => p.type.imports),
    ...(op.body?.type.imports ?? []),
    ...op.result.type.imports,
  ]);
}

export function planServerFiles(ir: KotlinIR, options: KtorServerOptions, registry: ExtensionRegistry): FileSpec[] {
  if (ir.services.length === 0) return [];
  const style = resolveStyle(options["routing-style"], registry);
  const pkg = options.package ?? `${ir.basePackage}.server`;
  const dir = `server/${pkg.replaceAll(".", "/")}`;
  const files: FileSpec[] = [
    {
      path: `${dir}/ServerSupport.kt`,
      template: "kotlin/file",
      data: { package: pkg, imports: SUPPORT_IMPORTS, body: "ktor-server/support" },
    },
  ];
  for (const service of ir.services) {
    const units = buildUnits(service, options.grouping);
    for (const unit of units) {
      files.push(serviceFile(unit, pkg, dir, options), routesFile(unit, pkg, dir, options, style));
    }
    files.push(moduleFile(ir, service, units, pkg, dir, style));
  }
  return files;
}

function serviceFile(unit: ServerUnit, pkg: string, dir: string, options: KtorServerOptions): FileSpec {
  const imports = [
    ...typeImports(unit.operations),
    ...(options["call-access"] ? ["io.ktor.server.application.ApplicationCall"] : []),
  ];
  return {
    path: `${dir}/${unit.serviceName}.kt`,
    template: "kotlin/file",
    data: { package: pkg, imports: organizeImports(imports, pkg), body: "ktor-server/service", unit, options },
  };
}

function routesFile(
  unit: ServerUnit,
  pkg: string,
  dir: string,
  options: KtorServerOptions,
  style: RoutingStyle,
): FileSpec {
  const imports = [...typeImports(unit.operations), ...style.imports(unit, options)];
  return {
    path: `${dir}/${unit.name}Routes.kt`,
    template: "kotlin/file",
    data: { package: pkg, imports: organizeImports(imports, pkg), body: style.template, unit, options },
  };
}

function moduleFile(
  ir: KotlinIR,
  service: KtService,
  units: ServerUnit[],
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
  const imports = [...MODULE_IMPORTS, ...installs, ...exceptions.keys(), `${ir.apiPackage}.ApiException`];
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
      installs,
      exceptions: [...exceptions.values()],
      moduleFn: `${base}Module`,
      apiRoutesFn: `${base}ApiRoutes`,
      errorsFn: `${base}Errors`,
    },
  };
}
