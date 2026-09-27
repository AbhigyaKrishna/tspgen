import {
  getNamespaceFullName,
  getSourceLocation,
  listServices,
  NoTarget,
  type Diagnostic,
  type Enum,
  type Namespace,
  type Program,
} from "@typespec/compiler";
import { unsafe_mutateSubgraphWithNamespace, type unsafe_MutatorWithNamespace } from "@typespec/compiler/experimental";
import { errorMessage, reportDiagnostic } from "../lib.js";

/** A version of a `@versioned` service. */
interface Version {
  name: string;
  value: string;
  enumMember: { enum: Enum };
}

/**
 * The part of `@typespec/versioning` tspgen uses. Typed structurally: the package is an optional peer
 * dependency, so the published declarations must not depend on it.
 */
export interface VersioningApi {
  getVersioningMutators(
    program: Program,
    namespace: Namespace,
  ):
    | { kind: "versioned"; snapshots: readonly { version: Version; mutator: unsafe_MutatorWithNamespace }[] }
    | { kind: "transient"; mutator: unsafe_MutatorWithNamespace }
    | undefined;
}

/** A service namespace to build: the declared one, or its clone mutated to one version. */
export interface ResolvedService {
  namespace: Namespace;
  /** The version the namespace was mutated to (versioned services only). */
  version?: { name: string; value: string };
  /** True when `namespace` is a mutated clone (versioned or transient service). */
  mutated: boolean;
  /** The version enum of a versioned service; it is represented by the version constant, not as a type. */
  versionEnum?: Enum;
}

/** Result of `loadVersioning`: `failed` when the program uses versioning but the package could not be loaded. */
export interface LoadedVersioning {
  versioning?: VersioningApi;
  failed: boolean;
}

/**
 * `@typespec/versioning`, when the program uses it (the spec imports it, so it is installed). Loaded lazily:
 * the package is an optional peer dependency. A load failure is reported (`module-load-failed`); callers must
 * not fall back to an unversioned build.
 */
export async function loadVersioning(program: Program): Promise<LoadedVersioning> {
  const typespec = program.getGlobalNamespaceType().namespaces.get("TypeSpec");
  if (!typespec?.namespaces.has("Versioning")) return { failed: false };
  try {
    const versioning = (await import("@typespec/versioning")) as unknown as VersioningApi;
    return { versioning: { getVersioningMutators: versioning.getVersioningMutators }, failed: false };
  } catch (error) {
    reportDiagnostic(program, {
      code: "module-load-failed",
      format: { kind: "library", specifier: "@typespec/versioning", message: errorMessage(error) },
      target: NoTarget,
    });
    return { failed: true };
  }
}

/** Services to build; `failed` when a versioned service has no such version (reported), and nothing should be written. */
export interface ServiceResolution {
  services: ResolvedService[];
  failed: boolean;
}

/**
 * The service namespaces to build. Services are listed before anything is mutated: mutation re-runs
 * decorators (`@service` included) on the clones. Without services the global namespace is the service,
 * as for `getAllHttpServices`.
 */
export function resolveServices(
  program: Program,
  versioning: VersioningApi | undefined,
  version: string | undefined,
): ServiceResolution {
  const declared = listServices(program).map((s) => s.type);
  if (declared.length === 0) {
    warnUnusedVersion(program, version, false);
    return { services: [{ namespace: program.getGlobalNamespaceType(), mutated: false }], failed: false };
  }
  const resolved: ResolvedService[] = [];
  let anyVersioned = false;
  let failed = false;
  for (const ns of declared) {
    const mutators = versioning?.getVersioningMutators(program, ns);
    if (!mutators) {
      resolved.push({ namespace: ns, mutated: false });
      continue;
    }
    if (mutators.kind === "transient") {
      resolved.push({ namespace: mutate(program, mutators.mutator, ns), mutated: true });
      continue;
    }
    anyVersioned = true;
    const snapshots = mutators.snapshots;
    const snapshot =
      version === undefined
        ? snapshots[snapshots.length - 1]
        : (snapshots.find((s) => s.version.name === version) ?? snapshots.find((s) => s.version.value === version));
    if (!snapshot) {
      failed = true;
      reportDiagnostic(program, {
        code: "unknown-version",
        format: {
          version: version ?? "",
          service: getNamespaceFullName(ns),
          versions: snapshots.map((s) => (s.version.name === s.version.value ? s.version.name : `${s.version.name} ("${s.version.value}")`)).join(", "),
        },
        target: ns,
      });
      continue;
    }
    resolved.push({
      namespace: mutate(program, snapshot.mutator, ns),
      version: { name: snapshot.version.name, value: snapshot.version.value },
      mutated: true,
      versionEnum: snapshot.version.enumMember.enum,
    });
  }
  warnUnusedVersion(program, version, anyVersioned);
  return { services: resolved, failed };
}

/**
 * Mutation re-runs the decorators on the clones. A diagnostic the compiler already reported for the declared
 * type (same code, message and source position: clones share their declaration's node) is dropped; one only a
 * version has (e.g. `@maxLength` on a property whose type is `int32` at that version) is reported.
 */
function mutate(program: Program, mutator: unsafe_MutatorWithNamespace, ns: Namespace): Namespace {
  const { reportDiagnostic, reportDiagnostics } = program;
  const reported = new Set(program.diagnostics.map(diagnosticKey));
  const report = (diagnostic: Diagnostic) => {
    const key = diagnosticKey(diagnostic);
    if (reported.has(key)) return;
    reported.add(key);
    reportDiagnostic(diagnostic);
  };
  program.reportDiagnostic = report;
  program.reportDiagnostics = (diagnostics) => diagnostics.forEach(report);
  try {
    return unsafe_mutateSubgraphWithNamespace(program, [mutator], ns).type as Namespace;
  } finally {
    program.reportDiagnostic = reportDiagnostic;
    program.reportDiagnostics = reportDiagnostics;
  }
}

function diagnosticKey(diagnostic: Diagnostic): string {
  const location = getSourceLocation(diagnostic.target);
  return [diagnostic.code, diagnostic.message, location?.file.path ?? "", location?.pos ?? "", location?.end ?? ""].join("\0");
}

function warnUnusedVersion(program: Program, version: string | undefined, anyVersioned: boolean): void {
  if (version !== undefined && !anyVersioned) {
    reportDiagnostic(program, { code: "unused-version", format: { version }, target: NoTarget });
  }
}
