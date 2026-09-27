import { metaStrings, reportDiagnostic, type AuthRequirementIR, type ExtensionRegistry, type FileSpec } from "@abhigyakrishna/tspgen-core";
import { NoTarget, type Program, type Type } from "@typespec/compiler";
import {
  camel,
  kotlinString,
  organizeImports,
  typeName,
  type KotlinIR,
  type KtService,
} from "@abhigyakrishna/tspgen-kotlin";
import { withContext, type ServerOperation } from "./context.js";
import type { KtorServerOptions } from "./options.js";
import { commonPrefix, routeTree, type RouteFunction } from "./routes.js";
import { builtinStyles, resolveStyle, type RoutingStyle } from "./styles.js";
import { buildUnits, type ServerUnit } from "./units.js";
import { frameFunction, sseFunctions, sseImports, sseJsonExpr, sseMode, ssePlan } from "./sse.js";
import { multipartMode, PartClasses, planUpload, uploadLimit, type SupportNeed } from "./uploads.js";

const TARGET_NAME = "@abhigyakrishna/tspgen-kotlin-ktor-server";

/** Ktor's default `formFieldLimit`. */
const DEFAULT_UPLOAD_LIMIT = 52428800;

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

/** ServerSupport.kt helpers per upload need, their imports, and the functions routes elsewhere import. */
const UPLOAD_SUPPORT: Record<SupportNeed, { imports: (ir: KotlinIR) => string[]; functions: string[] }> = {
  limit: {
    imports: () => [
      "io.ktor.http.content.MultiPartData",
      "io.ktor.server.plugins.PayloadTooLargeException",
      "io.ktor.server.request.receiveMultipart",
      "java.util.concurrent.atomic.AtomicReference",
      "kotlinx.coroutines.CancellationException",
      "kotlinx.coroutines.coroutineScope",
      "kotlinx.coroutines.job",
      "kotlinx.io.IOException",
    ],
    functions: ["withMultipart"],
  },
  parts: {
    imports: () => [
      "io.ktor.http.content.PartData",
      "io.ktor.http.content.forEachPart",
      "io.ktor.server.plugins.BadRequestException",
      "io.ktor.server.request.receiveMultipart",
      "io.ktor.utils.io.toByteArray",
    ],
    functions: ["partText"],
  },
  json: {
    imports: (ir) => (ir.javaTimeModule ? [ir.javaTimeModule] : []),
    functions: ["partJson"],
  },
  buffered: { imports: () => [], functions: ["receiveParts"] },
  files: { imports: (ir) => [`${ir.modelsPackage}.HttpFile`], functions: [] },
  streaming: {
    imports: () => [
      "java.util.concurrent.atomic.AtomicBoolean",
      "kotlinx.coroutines.flow.Flow",
      "kotlinx.coroutines.flow.FlowCollector",
      "kotlinx.coroutines.flow.flow",
    ],
    functions: ["partsFlow"],
  },
  channel: { imports: () => ["io.ktor.utils.io.ByteReadChannel"], functions: ["partChannel", "partFileName"] },
  file: {
    imports: (ir) => [
      `${ir.modelsPackage}.HttpFile`,
      "io.ktor.http.ContentDisposition",
      "io.ktor.http.HttpHeaders",
      "io.ktor.server.plugins.PayloadTooLargeException",
      "io.ktor.server.request.receiveChannel",
      "io.ktor.utils.io.readBuffer",
      "kotlinx.io.readByteArray",
    ],
    functions: ["receiveFile"],
  },
};

const SUPPORT_NEEDS: readonly SupportNeed[] = ["limit", "parts", "json", "buffered", "files", "streaming", "channel", "file"];

function withSse(program: Program, op: ServerOperation, options: KtorServerOptions): ServerOperation {
  if (op.result.kind !== "single" || !op.result.stream) return op;
  return { ...op, sse: sseMode(program, op, options.sse ?? "text-writer") };
}

function withUpload(
  program: Program,
  op: ServerOperation,
  options: KtorServerOptions,
  classes: PartClasses,
  flowClash: boolean,
): ServerOperation {
  if (!op.body || op.body.kind === "single") return op;
  const mode = multipartMode(program, op, options.multipart ?? "buffered");
  const limit = uploadLimit(program, op, options["max-upload-size"] ?? DEFAULT_UPLOAD_LIMIT);
  const upload = planUpload(op, mode, limit, classes, flowClash);
  return upload ? { ...op, upload } : op;
}

/** Types the service (`fields`) or routes file refers to; upload routes get theirs from `upload.routeImports`. */
function typeImports(ops: ServerOperation[], file: "service" | "routes" = "service"): string[] {
  return ops.flatMap((op) => [
    ...op.params.flatMap((p) => p.type.imports),
    ...(op.upload
      ? file === "service"
        ? op.upload.fields.flatMap((f) => f.type.imports)
        : []
      : (op.body?.type.imports ?? [])),
    // Routes hand a stream to ServerSupport's writer without naming its types.
    ...(file === "routes" && op.sse ? [] : op.result.type.imports),
    ...op.context.flatMap((c) => c.type.imports),
  ]);
}

/** The `@meta("kotlin:ktor-server", …)` keys this target reads, for plugins that write or read them. */
export interface KtorServerMeta {
  annotations?: string[];
  /** Auth provider names: renders `authenticate(...)` as the outermost wrapper. */
  authenticate?: string[];
  /** Wrapper calls around the route, outermost first (dsl routing only). */
  wrap?: string[];
  /** Extra imports for the routes file. */
  imports?: string[];
  /** Route-set function the operation is mounted in (dsl routing only). */
  routeSet?: string;
  /** Service parameters supplied by a route-handler expression; `replaces` drops those request parameters. */
  context?: { name: string; type: string; expr: string; replaces?: string[] }[];
}

export interface ServerOpExtras {
  annotations: string[];
  /**
   * Provider names of the route's `authenticate(...)` wrapper, empty without one: the `authenticate` meta key,
   * else the scheme ids of the wrapper generated from `@useAuth`. A routing style or routes template rendering
   * `authenticate(<names as strings>)` from this keeps protecting routes, but only `auth` (or `authProviders`,
   * `authStrategy` and `authOptional`) says everything the wrapper needs.
   */
  authenticate: string[];
  /** Kotlin expressions naming those providers: string literals, or the `auth-providers` expressions. */
  authProviders: string[];
  /** `AuthenticationStrategy` member the wrapper passes as `strategy` (import `io.ktor.server.auth.AuthenticationStrategy`). */
  authStrategy?: "Required";
  /** The wrapper passes `optional = true`. */
  authOptional?: boolean;
  /** The route's `authenticate(...)` wrapper call (at most one), rendered from the fields above. */
  auth: string[];
  /** Full wrapper chain, outermost first: `auth`, then `wrap`. */
  wrap: string[];
  /** Extra imports for the routes file (`imports` key). */
  imports: string[];
  routeSet?: string;
}

/** A route's `authenticate(...)` wrapper: provider names and expressions (parallel), and its arguments. */
interface AuthWrapper {
  names: string[];
  providers: string[];
  strategy?: "Required";
  optional?: boolean;
}

function renderAuth(wrapper: AuthWrapper): string {
  const args = [
    ...wrapper.providers,
    ...(wrapper.strategy ? [`strategy = AuthenticationStrategy.${wrapper.strategy}`] : []),
    ...(wrapper.optional ? ["optional = true"] : []),
  ];
  return `authenticate(${args.join(", ")})`;
}

function serverExtras(program: Program, units: ServerUnit[], options: KtorServerOptions): Record<string, ServerOpExtras> {
  const extras: Record<string, ServerOpExtras> = {};
  for (const unit of units) {
    for (const op of unit.operations) {
      const meta = op.meta["kotlin:ktor-server"] ?? {};
      const names = metaStrings(program, meta, "authenticate", op.id);
      const [routeSet] = metaStrings(program, meta, "routeSet", op.id);
      const wrapper: AuthWrapper | undefined =
        names.length > 0 ? { names, providers: names.map((n) => kotlinString(n)) } : generatedAuth(program, op, options);
      const auth = wrapper ? [renderAuth(wrapper)] : [];
      extras[op.id] = {
        annotations: metaStrings(program, meta, "annotations", op.id),
        authenticate: wrapper?.names ?? [],
        authProviders: wrapper?.providers ?? [],
        ...(wrapper?.strategy ? { authStrategy: wrapper.strategy } : {}),
        ...(wrapper?.optional ? { authOptional: true } : {}),
        auth,
        // A wrapper declared both on the namespace and on the operation renders once.
        wrap: [...new Set([...auth, ...metaStrings(program, meta, "wrap", op.id)])],
        imports: metaStrings(program, meta, "imports", op.id),
        ...(routeSet ? { routeSet } : {}),
      };
    }
  }
  return extras;
}

/** `A & B | C` notation of a requirement, for diagnostics. */
function describeAuth(auth: AuthRequirementIR): string {
  return auth.options
    .map((option) => (option.length === 0 ? "NoAuth" : option.length === 1 ? option[0] : `(${option.join(" & ")})`))
    .join(" | ");
}

/**
 * The `authenticate(...)` wrapper for an operation's `@useAuth`: one scheme or alternatives of one scheme each →
 * `authenticate(a, b)` (the first valid credential wins); one alternative of several schemes → `strategy = Required`
 * (Ktor merges nested `authenticate` blocks into one set, so nesting would accept any of them); any alternative
 * with `NoAuth` → every scheme mentioned, `optional = true`: anonymous calls pass, the first valid credential wins
 * (the others are not checked) and only credentials that are all invalid are rejected; an alternative needing
 * several schemes is thereby loosened (warned as `auth-combination-approximated`). Several alternatives of which
 * some need more than one scheme cannot be expressed: they are reported and fail closed, requiring every scheme
 * mentioned (`strategy = Required`).
 */
function generatedAuth(program: Program, op: ServerOperation, options: KtorServerOptions): AuthWrapper | undefined {
  if (options["generate-auth"] === false || !op.auth) return undefined;
  const alternatives = op.auth.options.map((option) => [...new Set(option)]);
  const required = alternatives.filter((option) => option.length > 0);
  if (required.length === 0) return undefined;
  const of = (ids: string[]) => ({
    names: ids,
    providers: ids.map((id) => options["auth-providers"]?.[id] ?? kotlinString(id)),
  });
  if (required.length < alternatives.length) {
    const wrapper: AuthWrapper = { ...of([...new Set(required.flat())]), optional: true };
    // Ktor accepts the first valid credential of the set, so an alternative needing several schemes is loosened.
    if (required.some((option) => option.length > 1)) {
      reportDiagnostic(program, {
        code: "auth-combination-approximated",
        format: {
          operation: op.id,
          requirement: describeAuth(op.auth),
          target: "the Ktor server",
          wrapper: renderAuth(wrapper),
          hint: '@meta("kotlin:ktor-server", #{ authenticate: … })',
        },
        target: operationTarget(program, op.id),
      });
    }
    return wrapper;
  }
  if (required.length === 1 && required[0].length > 1) return { ...of(required[0]), strategy: "Required" };
  if (required.every((option) => option.length === 1)) return of(required.flat());
  // Fail closed: the strictest wrapper covering every scheme mentioned, so the route is never left unprotected.
  const all = [...new Set(required.flat())];
  reportDiagnostic(program, {
    code: "unsupported-auth-combination",
    format: {
      operation: op.id,
      requirement: describeAuth(op.auth),
      target: "the Ktor server",
      fallback: `every scheme (${all.join(" & ")})`,
      hint: '@meta("kotlin:ktor-server", #{ authenticate: … })',
    },
    target: operationTarget(program, op.id),
  });
  return { ...of(all), strategy: "Required" };
}

/**
 * Templates rendering `authenticate(...)` wrappers per built-in style. A routing style from a plugin, or one of these
 * templates overridden, may render only `ServerOpExtras.authenticate` (provider names, as before generated auth),
 * which drops a wrapper's `strategy`/`optional` and `auth-providers` expressions: warn for routes needing them.
 */
const WRAPPER_TEMPLATES: Record<string, string[]> = {
  dsl: ["ktor-server/routes/dsl", "ktor-server/routes/dsl-nodes"],
  resources: ["ktor-server/routes/resources"],
};

function checkAuthRendering(
  program: Program,
  options: KtorServerOptions,
  style: RoutingStyle,
  units: ServerUnit[],
  extras: Record<string, ServerOpExtras>,
  overridden: (template: string) => boolean,
): void {
  const name = options["routing-style"];
  const where =
    builtinStyles[name] !== style
      ? `routing style '${name}'`
      : WRAPPER_TEMPLATES[name]?.filter(overridden).map((t) => `overridden template '${t}'`)[0];
  if (!where) return;
  for (const op of units.flatMap((u) => u.operations)) {
    const e = extras[op.id];
    const mapped = e.authProviders.some((p, i) => p !== kotlinString(e.authenticate[i]));
    if (!e.authStrategy && !e.authOptional && !mapped) continue;
    reportDiagnostic(program, {
      code: "auth-wrapper-not-rendered",
      format: { operation: op.id, wrapper: e.auth[0], where },
      target: operationTarget(program, op.id),
    });
  }
}

/** The TypeSpec operation an operation id names, for diagnostics; `NoTarget` when it does not resolve. */
function operationTarget(program: Program, id: string): Type | typeof NoTarget {
  const [type] = program.resolveTypeReference(id);
  return type?.kind === "Operation" ? type : NoTarget;
}

/**
 * `auth-providers` expressions must not be blank (an error: `authenticate(, …)` would not compile); a key naming
 * no auth scheme of any service is likely a typo or a scheme renamed by deduplication (`ApiKeyAuth_`): warn.
 */
function checkAuthProviders(program: Program, ir: KotlinIR, options: KtorServerOptions): boolean {
  const providers = options["auth-providers"] ?? {};
  const blank = Object.keys(providers).filter((key) => providers[key].trim() === "");
  if (blank.length > 0) {
    reportDiagnostic(program, {
      code: "invalid-target-options",
      format: {
        name: TARGET_NAME,
        errors: blank.map((key) => `auth-providers.${key} must be a Kotlin expression, not blank`).join("; "),
      },
      target: NoTarget,
    });
    return false;
  }
  const ids = [...new Set(ir.services.flatMap((s) => s.auth.filter((a) => a.type !== "noAuth").map((a) => a.id)))];
  for (const key of Object.keys(providers)) {
    if (ids.includes(key)) continue;
    reportDiagnostic(program, {
      code: "unknown-auth-provider",
      format: { key, ids: ids.length > 0 ? ids.join(", ") : "none" },
      target: NoTarget,
    });
  }
  return true;
}

/** `wrap`, `routeSet` and `nest-routes` are dsl-only; other styles must not silently drop guards. */
function checkDslOnly(options: KtorServerOptions, units: ServerUnit[], extras: Record<string, ServerOpExtras>): void {
  if (options["routing-style"] === "dsl") return;
  const used =
    options["nest-routes"] ||
    units.some((u) =>
      u.operations.some((op) => {
        const e = extras[op.id];
        return e.routeSet !== undefined || e.wrap.length > e.auth.length;
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
  /** Whether a logical template is rendered by a file other than this target's own (template-dir, plugin). */
  overridden: (template: string) => boolean = () => false,
): FileSpec[] {
  if (ir.services.length === 0) return [];
  if (!checkAuthProviders(program, ir, options)) return [];
  const style = resolveStyle(options["routing-style"], registry);
  const supportPkg = options.package ?? `${ir.basePackage}.server`;
  const dirOf = (pkg: string) => `server/${pkg.replaceAll(".", "/")}`;
  const files: FileSpec[] = [];
  const partClasses = new PartClasses(supportPkg);
  // A generated type named Flow: kotlinx's Flow is written qualified in the streaming upload path.
  const flowClash = ir.declarations.some((d) => d.name === "Flow");
  const serviceUnits = ir.services.map((service) =>
    buildUnits(service, options.grouping, options["service-suffix"]).map((unit) => ({
      ...unit,
      operations: unit.operations.map((op) =>
        withSse(
          program,
          withUpload(program, withContext(program, op, op.meta["kotlin:ktor-server"] ?? {}), options, partClasses, flowClash),
          options,
        ),
      ),
    })),
  );
  const used = new Set(serviceUnits.flat().flatMap((u) => u.operations.flatMap((op) => op.upload?.support ?? [])));
  const needs = SUPPORT_NEEDS.filter((n) => used.has(n));
  const sse = ssePlan(serviceUnits.flat().flatMap((u) => u.operations));
  const supportFunctions = [
    ...SUPPORT_FUNCTIONS,
    ...needs.flatMap((n) => UPLOAD_SUPPORT[n].functions),
    ...(sse ? sseFunctions(sse) : []),
  ].sort();
  files.push({
    path: `${dirOf(supportPkg)}/ServerSupport.kt`,
    template: "kotlin/file",
    data: {
      package: supportPkg,
      imports: organizeImports(
        [
          ...SUPPORT_IMPORTS,
          ...needs.flatMap((n) => UPLOAD_SUPPORT[n].imports(ir)).filter((i) => !flowClash || i !== "kotlinx.coroutines.flow.Flow"),
          ...(sse ? sseImports(sse, ir) : []),
        ],
        supportPkg,
      ),
      body: "ktor-server/support",
      uploads: Object.fromEntries(needs.map((n) => [n, true])),
      flowType: flowClash ? "kotlinx.coroutines.flow.Flow" : "Flow",
      partJson: ir.javaTimeModule ? `Json { serializersModule = ${ir.javaTimeModule.slice(ir.javaTimeModule.lastIndexOf(".") + 1)} }` : "Json",
      ...(sse
        ? {
            sse: {
              ...sse,
              jsonExpr: sseJsonExpr(ir),
              frames: [
                ...sse.events.map((d) => frameFunction(d).join("\n")),
                ...(sse.sseMessage ? ["internal fun SseMessage.sseFrame(): TspgenSseFrame = TspgenSseFrame(event, data, id)"] : []),
              ],
            },
          }
        : {}),
    },
  });
  for (const part of partClasses.all()) {
    files.push({
      path: `${dirOf(supportPkg)}/${part.name}.kt`,
      template: "kotlin/file",
      data: { package: supportPkg, imports: organizeImports(part.imports, supportPkg), body: "ktor-server/part-class", decl: part.lines.join("\n") },
    });
  }
  for (const [index, service] of ir.services.entries()) {
    const units = serviceUnits[index];
    const extras = serverExtras(program, units, options);
    checkDslOnly(options, units, extras);
    checkAuthRendering(program, options, style, units, extras, overridden);
    const functions = new Map(units.map((unit) => [unit, routeFunctions(unit, options, extras)]));
    for (const unit of units) {
      const pkg = unit.package ?? supportPkg;
      const support = pkg === supportPkg ? [] : supportFunctions.map((f) => `${supportPkg}.${f}`);
      files.push(
        serviceFile(unit, pkg, dirOf(pkg), options, extras),
        routesFile(unit, pkg, dirOf(pkg), options, style, extras, support, functions.get(unit)!),
      );
    }
    if (options.module) files.push(moduleFile(ir, service, units, functions, supportPkg, dirOf(supportPkg), style, sse?.json ?? false));
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
    data: {
      package: pkg,
      imports: organizeImports(imports, pkg),
      body: "ktor-server/service",
      unit,
      options,
      extras,
    },
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
    ...typeImports(unit.operations, "routes"),
    ...style.imports(unit, options),
    ...support,
    ...unit.operations.flatMap((op) => extras[op.id].imports),
    ...(unit.operations.some((op) => extras[op.id].auth.length > 0) ? ["io.ktor.server.auth.authenticate"] : []),
    ...(unit.operations.some((op) => extras[op.id].authStrategy) ? ["io.ktor.server.auth.AuthenticationStrategy"] : []),
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
  sharedJson: boolean,
): FileSpec {
  const exceptions = new Map<string, string>();
  for (const unit of units) {
    for (const op of unit.operations) {
      for (const error of op.errors) {
        if (error.exception.text !== "ApiException") exceptions.set(error.exception.imports[0], error.exception.text);
      }
    }
  }
  // The SSE plugin when an operation streams through it.
  const sse = units.some((u) => u.operations.some((op) => op.sse === "plugin")) ? ["io.ktor.server.sse.SSE"] : [];
  const installs = [...(style.plugins ?? []), ...sse];
  const unitImports = units
    .filter((u) => u.package && u.package !== pkg)
    .flatMap((u) => [`${u.package}.${u.serviceName}`, ...functions.get(u)!.map((f) => `${u.package}.${f.name}`)]);
  // With JSON event payloads, content negotiation installs ServerSupport's sseJson: REST and events share one Json.
  const javaTime = ir.javaTimeModule && !sharedJson ? [ir.javaTimeModule, "kotlinx.serialization.json.Json"] : [];
  const imports = [...MODULE_IMPORTS, ...installs, ...exceptions.keys(), `${ir.apiPackage}.ApiException`, ...unitImports, ...javaTime];
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
      json: sharedJson ? "sseJson" : ir.javaTimeModule ? `Json { serializersModule = ${ir.javaTimeModule.slice(ir.javaTimeModule.lastIndexOf(".") + 1)} }` : "",
      exceptions: [...exceptions.values()],
      moduleFn: `${base}Module`,
      apiRoutesFn: `${base}ApiRoutes`,
      errorsFn: `${base}Errors`,
    },
  };
}
