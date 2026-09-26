import {
  getNamespaceFullName,
  getService,
  getTypeName,
  isErrorModel,
  type Interface,
  type Namespace,
  type Program,
} from "@typespec/compiler";
import {
  getAllHttpServices,
  getAuthentication,
  getServers,
  type HttpOperation,
  type HttpOperationResponse,
  type HttpService,
} from "@typespec/http";
import { pascal } from "../naming.js";
import { collectDecorators } from "./decorators.js";
import { docInfo } from "./docs.js";
import { splitNamespace, type TypeCollector } from "./type-collector.js";
import type {
  AuthIR,
  DecoratorData,
  OperationGroupIR,
  OperationIR,
  ParamIR,
  ResponseIR,
  ServiceIR,
  StatusCodes,
} from "./types.js";

export function buildServices(program: Program, collector: TypeCollector): ServiceIR[] {
  const [services, diagnostics] = getAllHttpServices(program);
  program.reportDiagnostics(diagnostics);
  return services.map((s) => buildService(program, collector, s));
}

function buildService(program: Program, collector: TypeCollector, service: HttpService): ServiceIR {
  const ns = service.namespace;
  collector.collectNamespace(ns);
  const groups = new Map<string, OperationGroupIR>();
  for (const op of service.operations) {
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
    group.operations.push(buildOperation(program, collector, op, groupId));
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
  const params: ParamIR[] = op.parameters.parameters.map((p) => ({
    name: p.param.name,
    wireName: p.name,
    location: p.type,
    type: collector.ref(p.param.type, `${base}${pascal(p.param.name)}`),
    optional: p.param.optional,
    explode: "explode" in p ? Boolean(p.explode) : false,
    ...docInfo(program, p.param),
  }));
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
  const body = op.parameters.body;
  if (body) {
    const property = "property" in body ? body.property : undefined;
    ir.body = {
      ...(property ? { name: property.name } : {}),
      type: collector.ref(body.type, `${base}Request`),
      contentTypes: body.contentTypes,
      optional: property?.optional ?? false,
      kind: body.bodyKind,
    };
  }
  return ir;
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
