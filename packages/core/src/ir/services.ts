import {
  getNamespaceFullName,
  getService,
  getTypeName,
  isErrorModel,
  NoTarget,
  type Interface,
  type Model,
  type Namespace,
  type Program,
  type Type,
} from "@typespec/compiler";
import {
  getAllHttpServices,
  getAuthentication,
  getServers,
  type HttpOperation,
  type HttpOperationPart,
  type HttpOperationResponse,
  type HttpService,
} from "@typespec/http";
import { reportDiagnostic } from "../lib.js";
import { pascal } from "../naming.js";
import { collectDecorators } from "./decorators.js";
import { docInfo } from "./docs.js";
import { hasParts, isBytes, splitNamespace, type TypeCollector } from "./type-collector.js";
import type {
  AuthIR,
  DecoratorData,
  OperationGroupIR,
  OperationIR,
  ParamIR,
  PartIR,
  ResponseIR,
  ServiceIR,
  StatusCodes,
  TypeRef,
} from "./types.js";

type BuiltOperation = [HttpOperation, OperationIR];

export function buildServices(program: Program, collector: TypeCollector): ServiceIR[] {
  const [services, diagnostics] = getAllHttpServices(program);
  program.reportDiagnostics(diagnostics);
  const built: BuiltOperation[] = [];
  const result = services.map((s) => buildService(program, collector, s, built));
  checkJsonUses(program, collector, built);
  return result;
}

/** The nearest base of `model` declaring parts; TypeSpec only reads a multipart model's own properties. */
function partsBase(program: Program, model: Model): Model | undefined {
  for (let base = model.baseModel; base; base = base.baseModel) if (hasParts(program, base)) return base;
  return undefined;
}

function buildService(program: Program, collector: TypeCollector, service: HttpService, built: BuiltOperation[]): ServiceIR {
  const ns = service.namespace;
  collector.collectNamespace(ns);
  const groups = new Map<string, OperationGroupIR>();
  for (const op of service.operations) {
    const body = op.parameters.body;
    if (body?.bodyKind === "multipart" && body.multipartKind === "tuple") {
      reportDiagnostic(program, {
        code: "unsupported-multipart-tuple",
        format: { operation: getTypeName(op.operation) },
        target: op.operation,
      });
      continue;
    }
    const base = body?.bodyKind === "multipart" && body.type.kind === "Model" ? partsBase(program, body.type) : undefined;
    if (base) {
      reportDiagnostic(program, {
        code: "unsupported-multipart-base",
        format: {
          model: getTypeName(body!.type),
          operation: getTypeName(op.operation),
          base: getTypeName(base),
          baseName: base.name,
        },
        target: op.operation,
      });
      continue;
    }
    const container = op.container;
    const groupId = getTypeName(container);
    let group = groups.get(groupId);
    if (!group) {
      group = {
        id: groupId,
        name: container.name,
        namespace: namespaceOf(container),
        ...docInfo(program, container),
        decorators: collectDecorators(container),
        namespaceDecorators: enclosingNamespaceDecorators(container, ns),
        operations: [],
      };
      groups.set(groupId, group);
    }
    const ir = buildOperation(program, collector, op, groupId);
    built.push([op, ir]);
    group.operations.push(ir);
  }
  const fullName = getNamespaceFullName(ns);
  const title = getService(program, ns)?.title;
  return {
    id: fullName,
    name: ns.name,
    ...(title ? { title } : {}),
    namespace: splitNamespace(fullName),
    ...docInfo(program, ns),
    servers: (getServers(program, ns) ?? []).map((s) => ({
      url: s.url,
      ...(s.description ? { description: s.description } : {}),
      parameters: [...s.parameters.keys()],
    })),
    auth: buildAuth(program, ns),
    groups: [...groups.values()],
  };
}

function namespaceOf(container: Namespace | Interface): string[] {
  if (container.kind === "Namespace") return splitNamespace(getNamespaceFullName(container));
  return container.namespace ? splitNamespace(getNamespaceFullName(container.namespace)) : [];
}

/** Decorators of the namespaces enclosing `container`, from the service namespace inwards. */
function enclosingNamespaceDecorators(container: Namespace | Interface, service: Namespace): DecoratorData[] {
  const chain: Namespace[] = [];
  for (let current = container.namespace; current; current = current.namespace) {
    chain.unshift(current);
    if (current === service) return chain.map(collectDecorators);
  }
  return [];
}

function buildAuth(program: Program, ns: Namespace): AuthIR[] {
  const seen = new Map<string, AuthIR>();
  for (const option of getAuthentication(program, ns)?.options ?? []) {
    for (const scheme of option.schemes) {
      if (seen.has(scheme.id)) continue;
      const auth: AuthIR = { id: scheme.id, type: scheme.type };
      if (scheme.type === "http") auth.scheme = scheme.scheme;
      if (scheme.type === "apiKey") {
        auth.in = scheme.in;
        auth.name = scheme.name;
      }
      seen.set(scheme.id, auth);
    }
  }
  return [...seen.values()];
}

function buildOperation(
  program: Program,
  collector: TypeCollector,
  op: HttpOperation,
  groupId: string,
): OperationIR {
  const opName = op.operation.name;
  const base = pascal(opName);
  const body = op.parameters.body;
  // Multipart boundaries and file content types are set by the HTTP runtime, not by a parameter.
  const contentTypeParam = body && body.bodyKind !== "single" ? body.contentTypeProperty : undefined;
  const params: ParamIR[] = op.parameters.parameters
    .filter((p) => p.param !== contentTypeParam)
    .map((p) => {
    const constraints = collector.constraints(p.param);
    return {
      name: p.param.name,
      wireName: p.name,
      location: p.type,
      type: collector.ref(p.param.type, `${base}${pascal(p.param.name)}`),
      optional: p.param.optional,
      explode: "explode" in p ? Boolean(p.explode) : false,
      ...(constraints ? { constraints } : {}),
      ...docInfo(program, p.param),
    };
  });
  const ir: OperationIR = {
    id: `${groupId}.${opName}`,
    name: opName,
    verb: op.verb,
    path: op.path,
    ...docInfo(program, op.operation),
    params,
    responses: op.responses.flatMap((r) => buildResponses(program, collector, r, base, op.responses.length > 1)),
    decorators: collectDecorators(op.operation),
  };
  if (body) {
    const property = "property" in body ? body.property : undefined;
    ir.body = {
      ...(property ? { name: property.name } : {}),
      type: collector.ref(body.type, `${base}Request`),
      contentTypes: body.contentTypes,
      optional: property?.optional ?? false,
      kind: body.bodyKind,
    };
    const constraints = property ? collector.constraints(property) : undefined;
    if (constraints) ir.body.constraints = constraints;
    if (body.bodyKind === "multipart" && body.multipartKind === "model") {
      ir.body.parts = body.parts.map((part) => buildPart(program, collector, part, base));
    }
    if (body.bodyKind === "file") {
      ir.body.file = { isText: body.isText, contentTypes: declaredContentTypes(body.contentTypes) };
    }
  }
  return ir;
}

type ModelPart = Extract<HttpOperationPart, { partKind: "model" }>;

/** Content types a file declares; the `* / *` wildcard of a plain `Http.File` declares none. */
function declaredContentTypes(types: readonly string[]): string[] {
  return types.filter((t) => t !== "*/*");
}

function isJsonMediaType(type: string): boolean {
  return /[/+]json(;|$)/.test(type);
}

/** Whether a JSON part of this type is a JSON document rather than a text value: not a scalar, enum or literal. */
function isStructured(type: Type): boolean {
  switch (type.kind) {
    case "Model":
    case "Tuple":
      return true;
    case "Union":
      return [...type.variants.values()].some((v) => isStructured(v.type));
    default:
      return false;
  }
}

function buildPart(program: Program, collector: TypeCollector, part: ModelPart, base: string): PartIR {
  // `HttpPart<bytes>` carries binary content, like a file.
  const isFile = part.body.bodyKind === "file" || isBytes(part.body.type);
  const isJson = !isFile && part.body.contentTypes.some(isJsonMediaType) && isStructured(part.body.type);
  const { docs } = docInfo(program, part.property);
  return {
    name: part.name,
    property: part.property.name,
    optional: part.optional,
    multi: part.multi,
    kind: isFile ? "file" : isJson ? "json" : "text",
    type: isFile ? { kind: "file" } : collector.ref(part.body.type, `${base}${pascal(part.property.name)}`),
    contentTypes: isFile ? declaredContentTypes(part.body.contentTypes) : [...part.body.contentTypes],
    ...(docs ? { docs } : {}),
  };
}

/** Whether `ref` is or directly holds (through arrays, maps and nullability) a file. */
function holdsFile(ref: TypeRef): boolean {
  switch (ref.kind) {
    case "file":
      return true;
    case "array":
    case "map":
    case "nullable":
      return holdsFile(ref.of);
    case "named":
      return (ref.args ?? []).some(holdsFile);
    default:
      return false;
  }
}

/** Named types `ref` refers to, through arrays, maps, nullability and type arguments. */
function namedIds(ref: TypeRef): string[] {
  switch (ref.kind) {
    case "named":
      return [ref.id, ...(ref.args ?? []).flatMap(namedIds)];
    case "array":
    case "map":
    case "nullable":
      return namedIds(ref.of);
    default:
      return [];
  }
}

/**
 * Files and multipart models only travel as multipart parts / file bodies: warn where JSON would carry them
 * (JSON models, JSON request bodies, responses).
 */
function checkJsonUses(program: Program, collector: TypeCollector, built: BuiltOperation[]): void {
  const types = collector.getTypes();
  const multipart = new Set(types.filter((t) => t.kind === "model" && t.multipart).map((t) => t.id));
  // Targets are resolved only when reporting: `sourceOf` scans every type.
  const warnMultipart = (refs: TypeRef[], where: string, target: () => Type | typeof NoTarget) => {
    for (const id of new Set(refs.flatMap(namedIds))) {
      if (multipart.has(id)) {
        reportDiagnostic(program, { code: "multipart-model-in-json", format: { model: id, where }, target: target() });
      }
    }
  };
  for (const t of types) {
    if (t.kind === "enum" || (t.kind === "model" && t.multipart)) continue;
    const refs =
      t.kind === "model"
        ? [...t.properties.map((p) => p.type), ...(t.additionalProperties ? [t.additionalProperties] : [])]
        : t.variants.map((v) => v.type);
    const target = () => collector.sourceOf(t.id) ?? NoTarget;
    if (refs.some(holdsFile)) {
      reportDiagnostic(program, { code: "file-in-json", messageId: "default", format: { model: t.id }, target: target() });
    }
    warnMultipart(refs, `in '${t.id}'`, target);
  }
  for (const [op, ir] of built) {
    const responses = ir.responses.flatMap((r) => (r.body ? [r.body.type] : []));
    if (responses.some(holdsFile)) {
      reportDiagnostic(program, {
        code: "file-in-json",
        messageId: "response",
        format: { operation: getTypeName(op.operation) },
        target: op.operation,
      });
    }
    warnMultipart(responses, `response of '${getTypeName(op.operation)}'`, () => op.operation);
    if (ir.body?.kind === "single") warnMultipart([ir.body.type], `JSON body of '${getTypeName(op.operation)}'`, () => op.operation);
  }
}

function buildResponses(
  program: Program,
  collector: TypeCollector,
  response: HttpOperationResponse,
  base: string,
  multiple: boolean,
): ResponseIR[] {
  const codes = response.statusCodes;
  const statusCodes: StatusCodes =
    typeof codes === "number" ? codes : codes === "*" ? "default" : { start: codes.start, end: codes.end };
  const suffix =
    typeof statusCodes === "number" ? String(statusCodes) : statusCodes === "default" ? "Default" : String(statusCodes.start);
  const isError = isErrorModel(program, response.type);
  return response.responses.map((content) => {
    const ir: ResponseIR = {
      statusCodes,
      ...(response.description ? { description: response.description } : {}),
      isError,
      headers: content.properties.flatMap((p) =>
        p.kind === "header"
          ? [
              {
                name: p.property.name,
                wireName: p.options.name,
                type: collector.ref(p.property.type, `${base}${pascal(p.property.name)}`),
                optional: p.property.optional,
              },
            ]
          : [],
      ),
    };
    if (content.body) {
      ir.body = {
        type: collector.ref(content.body.type, `${base}Response${multiple ? suffix : ""}`),
        contentTypes: content.body.contentTypes,
      };
    }
    return ir;
  });
}
