import { statusRank, type FileSpec, type TargetContext } from "@abhigyakrishna/tspgen-core";
import {
  atLeastGo, checkHTTPConfiguration, goOperations, goSourceFile, httpModuleFile, httpOperationPlan,
  matchesStatus, operationImports, operationUnits, requestName, wireOptions,
  type GoClientOptions, type GoIR, type GoOperation, type GoSourceSection,
} from "@abhigyakrishna/tspgen-go";

const DEFAULT_MAX_RESPONSE_SIZE = 1024 * 1024;

type ReserveName = (identifier: string) => void;

function clientConfiguration(ir: GoIR, ctx: TargetContext, options: GoClientOptions) {
  const packageName = options.package ?? "client";
  const version = checkHTTPConfiguration(ir, ctx, options, packageName, "1.22");
  const name = options["client-name"] ?? "Client";
  const usesGenericMethods = ctx.features.values["generic-methods"] === true;
  const hasConstructor = ctx.features.values["client-constructor"] === true;
  if (usesGenericMethods && !atLeastGo(version, "1.27")) {
    throw new Error("features.generic-methods requires Go 1.27 or newer; set go-version to at least 1.27.");
  }
  if (name === "HTTPError") throw new Error("client-name conflicts with HTTPError.");
  return {
    packageName, version, name, usesGenericMethods, hasConstructor,
    wire: wireOptions(ctx, ir),
    timeout: options["timeout-ms"] ?? 0,
    maxResponseSize: options["max-response-size"] ?? DEFAULT_MAX_RESPONSE_SIZE,
    returnStatement: usesGenericMethods ? "return result, err" : "return err",
  };
}

type ClientConfiguration = ReturnType<typeof clientConfiguration>;

function clientIdentifiers(operations: GoOperation[], options: GoClientOptions, config: ClientConfiguration): ReserveName {
  const reserved = new Set([config.name, "HTTPError"]);
  if (config.hasConstructor) reserved.add(`New${config.name}`);
  const reserve: ReserveName = (identifier) => {
    if (reserved.has(identifier)) throw new Error(`Generated Go client identifier ${identifier} conflicts with another declaration.`);
    reserved.add(identifier);
  };
  const runtimeMembers = ["BaseURL", "HTTPClient", ...(config.usesGenericMethods ? ["Do"] : [])];
  for (const op of operations) {
    if (runtimeMembers.includes(op.name)) throw new Error(`Operation ${op.name} conflicts with the client runtime.`);
    reserve(requestName(op, options));
  }
  return reserve;
}

function clientOperation(op: GoOperation, ir: GoIR, ctx: TargetContext, options: GoClientOptions) {
  const plan = httpOperationPlan(op, ir, ctx, options, "client");
  const errors = [...plan.errors].sort((a, b) =>
    statusRank(a.response.statusCodes) - statusRank(b.response.statusCodes),
  );
  return {
    ...plan,
    returnStatement: plan.responseType ? "return result, err" : "return err",
    errorBranches: errors.map((error) => ({ ...error, condition: matchesStatus(error, "rawError.StatusCode") })),
  };
}

interface ClientFileContext {
  ir: GoIR;
  ctx: TargetContext;
  options: GoClientOptions;
  config: ClientConfiguration;
  reserve: ReserveName;
}

function clientOperationSection(operations: GoOperation[], context: ClientFileContext) {
  const { ir, ctx, options, config, reserve } = context;
  const plans = operations.map((op) => clientOperation(op, ir, ctx, options));
  const errors = plans.flatMap((op) => op.errors);
  for (const error of errors) reserve(error.name);
  const section: GoSourceSection = {
    template: "nethttp-client/operations",
    data: { operations: plans, errors, name: config.name, usesGenericMethods: config.usesGenericMethods, wire: config.wire },
  };
  const imports = [
    ...(operations.length ? ["context", "io", "net/url", "strings", "net/http", ir.module] : []),
    ...(operations.some((op) => op.body) ? ["bytes"] : []),
    ...(errors.length ? ["fmt", "errors"] : []),
    ...operationImports(operations, ir),
    ...errors.flatMap((error) => error.imports),
  ];
  return { section, imports };
}

export function planClientFiles(ir: GoIR, ctx: TargetContext): FileSpec[] {
  const options = ctx.options as unknown as GoClientOptions;
  const operations = goOperations(ctx.program, ir);
  const config = clientConfiguration(ir, ctx, options);
  const reserve = clientIdentifiers(operations, options, config);
  const fileContext: ClientFileContext = { ir, ctx, options, config, reserve };
  const runtime: GoSourceSection = { template: "nethttp-client/runtime", data: config };
  const runtimeImports = ["fmt", "net/http", "io", ir.module, ...(config.timeout ? ["time"] : [])];
  const files: FileSpec[] = [];
  if (ctx.features.values["go-mod"]) files.push(httpModuleFile("client", ir, ctx, options, config.version));
  if (!options.grouping || options.grouping === "single-file") {
    const all = clientOperationSection(operations, fileContext);
    files.push(goSourceFile("client/client.go", [runtime, all.section], [...runtimeImports, ...all.imports], ir, config.packageName));
  } else {
    files.push(goSourceFile("client/client.go", [runtime], runtimeImports, ir, config.packageName));
    for (const unit of operationUnits(operations, ir, options.grouping)) {
      const part = clientOperationSection(unit.operations, fileContext);
      files.push(goSourceFile(`client/${unit.file}_operations.go`, [part.section], part.imports, ir, config.packageName));
    }
  }
  if (ctx.program.hasError()) throw new Error("Cannot generate Go client; see the reported diagnostics.");
  return files;
}
