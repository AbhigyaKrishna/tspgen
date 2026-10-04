import type { FileSpec, TargetContext } from "@abhigyakrishna/tspgen-core";
import { checkHTTPConfiguration, operationUnits, type OperationUnit } from "../http.js";
import { httpModuleFile } from "../http/files.js";
import { wireOptions, type GoServerOptions, type GoWireOptions } from "../options.js";
import { goSourceFile, type GoSourceSection } from "../source.js";
import { goOperations, type GoIR } from "../transform.js";
import { referencesModels } from "../http/operations.js";
import { serverOperationPlan, type GoServerOperation } from "./operations.js";
import { serverRoutes } from "./routes.js";
import { serverTransport, type GoServerFramework, type GoServerTransport } from "./transport.js";

const DEFAULT_MAX_BODY_SIZE = 1024 * 1024;
const RUNTIME_NAMES = [
  "HTTPError", "NewHandler", "RegisterRoutes", "rejectHTTP", "writeHTTPJSON", "isNil", "serviceHTTPError",
  "readHTTPJSON", "escapedRoute", "pathValue", "reject", "writeJSON", "serviceError", "readJSONBody",
];

function serverConfiguration(ir: GoIR, ctx: TargetContext, options: GoServerOptions, transport: GoServerTransport) {
  const packageName = options.package ?? "server";
  const version = checkHTTPConfiguration(ir, ctx, options, packageName, transport.minimumVersion);
  if (options.module === "github.com/gin-gonic/gin") throw new Error("The server module must differ from the Gin module.");
  const service = options["service-name"] ?? "Service";
  return { packageName, version, service, wire: wireOptions(ctx, ir) };
}

function reserveServerIdentifiers(plans: GoServerOperation[], units: OperationUnit[], service: string): void {
  const reserved = new Set(RUNTIME_NAMES);
  const reserve = (name: string) => {
    if (reserved.has(name)) throw new Error(`Generated Go server identifier ${name} conflicts with another declaration.`);
    reserved.add(name);
  };
  reserve(service);
  for (const plan of plans) {
    reserve(plan.request.name);
    for (const error of plan.errors) reserve(error.name);
  }
  for (const unit of units) {
    reserve(`${unit.name}${service}`);
    reserve(`Register${unit.name}Routes`);
  }
}

interface ServerFileContext {
  ir: GoIR;
  packageName: string;
  transport: GoServerTransport;
  wire: GoWireOptions;
}

interface ServerOperationUnit {
  operations: GoServerOperation[];
  service: string;
  register: string;
}

function operationSection(unit: ServerOperationUnit, context: ServerFileContext): GoSourceSection {
  return {
    template: "go/server/operations",
    data: {
      ...unit,
      errors: unit.operations.flatMap((op) => op.errors),
      transport: context.transport,
      wire: context.wire,
    },
  };
}

function serverOperationImports(plans: GoServerOperation[], context: ServerFileContext): string[] {
  const { ir, transport, wire } = context;
  const errors = plans.flatMap((op) => op.errors);
  const usesHTTP = transport.framework === "nethttp" || plans.some((op) => op.params.length || (op.body && wire.validate));
  // Parameters decode, and validated bodies are checked, through the models runtime.
  const usesModels = plans.some((op) => op.params.length || (op.body && wire.validate) || referencesModels(op));
  return [
    ...(usesHTTP ? ["net/http"] : []),
    ...(transport.framework === "gin" ? ["github.com/gin-gonic/gin"] : []),
    ...(plans.length ? ["context"] : []),
    ...(usesModels ? [ir.module] : []),
    ...(errors.length ? ["fmt"] : []),
    ...plans.flatMap((op) => op.imports),
    ...errors.flatMap((error) => error.imports),
  ];
}

function runtimeSections(ctx: TargetContext, options: GoServerOptions, service: string, wire: GoWireOptions, transport: GoServerTransport): GoSourceSection[] {
  const runtime = {
    service, wire,
    handler: ctx.features.values.handler === true,
    errorBody: options["error-body"] ?? "json",
    maxBodySize: options["max-body-size"] ?? DEFAULT_MAX_BODY_SIZE,
  };
  return [
    { template: "go/server/http-runtime", data: runtime },
    { template: transport.runtimeTemplate, data: runtime },
  ];
}

function groupedOperationFiles(
  units: OperationUnit[], plans: GoServerOperation[], service: string, context: ServerFileContext,
): FileSpec[] {
  const byId = new Map(plans.map((plan) => [plan.id, plan]));
  return units.map((unit) => {
    const operations = unit.operations.map((op) => byId.get(op.id)!);
    const contract = { operations, service: `${unit.name}${service}`, register: `Register${unit.name}Routes` };
    return goSourceFile(
      `server/${unit.file}_operations.go`,
      [operationSection(contract, context)],
      serverOperationImports(operations, context),
      context.ir,
      context.packageName,
    );
  });
}

export function planServerFiles(ir: GoIR, ctx: TargetContext, framework: GoServerFramework): FileSpec[] {
  const options = ctx.options as unknown as GoServerOptions;
  const operations = goOperations(ctx.program, ir);
  const routes = serverRoutes(operations, ctx, framework);
  const transport = serverTransport(framework);
  const { packageName, version, service, wire } = serverConfiguration(ir, ctx, options, transport);
  const fileContext: ServerFileContext = { ir, packageName, transport, wire };
  const isGrouped = !!options.grouping && options.grouping !== "single-file";
  const units = isGrouped ? operationUnits(operations, ir, options.grouping) : [];
  const plans = routes.map((route) => serverOperationPlan(route, ir, ctx, options, transport));
  reserveServerIdentifiers(plans, units, service);
  const files: FileSpec[] = [];
  if (ctx.features.values["go-mod"]) files.push(httpModuleFile("server", ir, ctx, options, version, transport.moduleTemplate));
  const imports = ["bytes", "errors", "fmt", "io", "mime", "net/http", "reflect", "strings", ir.module, ...transport.imports];
  const sections = runtimeSections(ctx, options, service, wire, transport);
  if (isGrouped) {
    const groups = units.map((unit) => ({ service: `${unit.name}${service}`, register: `Register${unit.name}Routes` }));
    sections.push({ template: "go/server/groups", data: { service, transport, groups } });
    files.push(...groupedOperationFiles(units, plans, service, fileContext));
  } else {
    sections.push(operationSection({ operations: plans, service, register: "RegisterRoutes" }, fileContext));
    imports.push(...serverOperationImports(plans, fileContext));
  }
  files.push(goSourceFile("server/server.go", sections, imports, ir, packageName));
  if (ctx.program.hasError()) throw new Error("Cannot generate Go server; see the reported diagnostics.");
  return files;
}
