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
  getAuthentication,
  getHttpService,
  getServers,
  type Authentication,
  type HttpAuth,
  type HttpOperation,
  type HttpOperationPart,
  type HttpOperationResponse,
  type HttpService,
} from "@typespec/http";
import { reportDiagnostic } from "../lib.js";
import { isDefaultStatus, isFixedStatus } from "../http.js";
import { pascal } from "../naming.js";
import { collectDecorators, enclosingNamespaceDecorators } from "./decorators.js";
import { docInfo } from "./docs.js";
import { declaresStream, isEventStream, streamElement, streamEvents, type SseLibraries } from "./sse.js";
import { hasParts, isBytes, splitNamespace, type TypeCollector } from "./type-collector.js";
import type { ResolvedService } from "./versioning.js";
import type {
  AuthIR,
  AuthRequirementIR,
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

export function buildServices(
  program: Program,
  collector: TypeCollector,
  services: ResolvedService[],
  sse?: SseLibraries,
): ServiceIR[] {
  const httpServices = services.map((resolved) => {
    const [service, diagnostics] = getHttpService(program, resolved.namespace);
    program.reportDiagnostics(diagnostics);
    return service;
  });
  const built: BuiltOperation[] = [];
  const result = httpServices.map((service, i) => {
    collector.enterService(services[i]);
    const ir = buildService(program, collector, service, built, services[i].version, sse);
    collector.enterService(undefined);
    return ir;
  });
  checkJsonUses(program, collector, built);
  return result;
}

/** The nearest base of `model` declaring parts; TypeSpec only reads a multipart model's own properties. */
function partsBase(program: Program, model: Model): Model | undefined {
  for (let base = model.baseModel; base; base = base.baseModel) if (hasParts(program, base)) return base;
  return undefined;
}

function buildService(
  program: Program,
  collector: TypeCollector,
  service: HttpService,
  built: BuiltOperation[],
  version: ServiceIR["version"],
  sse: SseLibraries | undefined,
): ServiceIR {
  const ns = service.namespace;
  collector.collectNamespace(ns);
  const groups = new Map<string, OperationGroupIR>();
  const schemes = new AuthSchemes();
  schemes.requirement(getAuthentication(program, ns));
  for (const op of service.operations) {
    const body = op.parameters.body;
    if (body?.bodyKind === "multipart" && body.multipartKind === "tuple" && !collector.tuples) {
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
        namespaceDecorators: enclosingNamespaceDecorators(container),
        container: container.kind === "Namespace" ? "namespace" : "interface",
        operations: [],
      };
      groups.set(groupId, group);
    }
    const ir = collector.request(op.operation, op.verb, () => buildOperation(program, collector, op, groupId, sse));
    const auth = schemes.requirement(op.authentication);
    if (auth) ir.auth = auth;
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
    auth: schemes.all(),
    ...(version ? { version } : {}),
    groups: [...groups.values()],
  };
}

function namespaceOf(container: Namespace | Interface): string[] {
  if (container.kind === "Namespace") return splitNamespace(getNamespaceFullName(container));
  return container.namespace ? splitNamespace(getNamespaceFullName(container.namespace)) : [];
}

/**
 * The auth schemes of one service, deduplicated by id in first-use order (service `@useAuth` first). A different
 * scheme reusing an id gets `_` appended until unique, as `resolveAuthentication` does for OpenAPI, without
 * renaming the scheme objects TypeSpec keeps in its state.
 */
class AuthSchemes {
  private readonly byId = new Map<string, { auth: AuthIR; key: string }>();
  private readonly ids = new Map<HttpAuth, string>();

  requirement(authentication: Authentication | undefined): AuthRequirementIR | undefined {
    if (!authentication) return undefined;
    return {
      options: authentication.options.map((option) =>
        option.schemes.flatMap((scheme) => {
          const id = this.add(scheme);
          return scheme.type === "noAuth" ? [] : [id];
        }),
      ),
    };
  }

  all(): AuthIR[] {
    return [...this.byId.values()].map((entry) => entry.auth);
  }

  private add(scheme: HttpAuth): string {
    const known = this.ids.get(scheme);
    if (known) return known;
    const auth: AuthIR = { id: scheme.id, type: scheme.type };
    if (scheme.type === "http") auth.scheme = scheme.scheme;
    if (scheme.type === "apiKey") {
      auth.in = scheme.in;
      auth.name = scheme.name;
    }
    const key = schemeKey(scheme);
    let id = scheme.id;
    for (let entry = this.byId.get(id); entry && entry.key !== key; entry = this.byId.get(id)) id += "_";
    if (!this.byId.has(id)) this.byId.set(id, { auth: { ...auth, id }, key });
    this.ids.set(scheme, id);
    return id;
  }
}

/** What makes two schemes the same one: everything but the id, the model, the description and scopes. */
function schemeKey(scheme: HttpAuth): string {
  const { id: _id, model: _model, description: _description, ...rest } = scheme;
  if (rest.type === "oauth2") {
    return JSON.stringify({ ...rest, flows: rest.flows.map((flow) => ({ ...flow, scopes: [] })) });
  }
  if (rest.type === "openIdConnect") return JSON.stringify({ ...rest, scopes: [] });
  return JSON.stringify(rest);
}

function buildOperation(
  program: Program,
  collector: TypeCollector,
  op: HttpOperation,
  groupId: string,
  sse: SseLibraries | undefined,
): OperationIR {
  const opName = op.operation.name;
  const base = pascal(opName);
  const body = op.parameters.body;
  // Multipart boundaries and file content types are set by the HTTP runtime, not by a parameter.
  const contentTypeParam = body && (body.bodyKind !== "single" || collector.jsonLines && isJsonLines(body.contentTypes)) ? body.contentTypeProperty : undefined;
  const params: ParamIR[] = op.parameters.parameters
    .filter((p) => p.param !== contentTypeParam)
    .map((p) => {
    const constraints = collector.constraints(p.param);
    return {
      name: p.param.name,
      wireName: p.name,
      location: p.type,
      type: collector.propertyRef(p.param, `${base}${pascal(p.param.name)}`),
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
    responses: [],
    decorators: collectDecorators(op.operation),
  };
  const streams = { sse, streamable: streamable(program, op), rejected: false };
  ir.responses = collector.response(op.operation, () => op.responses.flatMap((r) => buildResponses(program, collector, op, r, base, op.responses.length > 1, streams)));
  if (streams.rejected) {
    reportDiagnostic(program, {
      code: "unsupported-sse-response",
      format: { operation: getTypeName(op.operation) },
      target: op.operation,
    });
  }
  if (body) {
    const property = "property" in body ? body.property : undefined;
    const bodyInfo = property ? docInfo(program, property) : {};
    const tupleParts = body.bodyKind === "multipart" && body.multipartKind === "tuple"
      ? buildTupleParts(program, collector, body.parts, base) : undefined;
    ir.body = {
      ...(property ? { name: property.name } : {}),
      ...(bodyInfo.docs ? { docs: bodyInfo.docs } : {}),
      ...(collector.exactLiterals && bodyInfo.deprecated !== undefined ? { deprecated: bodyInfo.deprecated } : {}),
      // `propertyRef` (rather than `ref`) so an explicit `@body`/`@bodyRoot` property's own `@encode` applies to a
      // scalar body; an implicit body (no `property`, the whole params model) has no property to carry `@encode`.
      type: tupleParts ? collector.multipartRef(ir.id, `${pascal(groupId)}${base}Multipart`, tupleParts)
        : property ? collector.propertyRef(property, `${base}Request`) : collector.ref(body.type, `${base}Request`),
      contentTypes: body.contentTypes,
      optional: property?.optional ?? false,
      kind: body.bodyKind,
      ...(tupleParts ? { parts: tupleParts, tupleMultipart: true } : {}),
    };
    const constraints = property ? collector.constraints(property) : undefined;
    if (constraints) ir.body.constraints = constraints;
    if (body.bodyKind === "multipart" && body.multipartKind === "model") {
      ir.body.parts = body.parts.map((part) => buildPart(program, collector, part, base));
    }
    if (body.bodyKind === "file") {
      ir.body.file = { isText: body.isText, contentTypes: declaredContentTypes(body.contentTypes) };
    }
    const item = collector.jsonLines && isJsonLines(body.contentTypes) ? streamElement(program, body, sse) : undefined;
    if (item) ir.body.jsonLines = collector.jsonLinesRef(item, `${base}Item`);
  }
  return ir;
}

type ModelPart = Extract<HttpOperationPart, { partKind: "model" }>;

function buildTupleParts(program: Program, collector: TypeCollector, parts: Extract<HttpOperationPart, { partKind: "tuple" }>[], base: string): PartIR[] {
  const taken = new Set(parts.flatMap((part) => part.name === undefined ? [] : [part.name]));
  for (const [index, part] of parts.entries()) {
    const repeatedName = part.name !== undefined && parts.slice(0, index).some((previous) => previous.name === part.name);
    const ambiguous = part.multi && part.name === undefined && parts.slice(index + 1).some((next) => next.name === undefined);
    if (repeatedName || ambiguous) reportDiagnostic(program, {
      code: "ambiguous-multipart-parts", format: { part: String(index + 1), operation: base }, target: part.body.type,
    });
  }
  return parts.map((part, index) => {
    let name = part.name ?? `part${index + 1}`;
    if (part.name === undefined) {
      while (taken.has(name)) name += "_";
      taken.add(name);
    }
    return { ...buildTuplePart(collector, part, index, base), name };
  });
}

function buildTuplePart(collector: TypeCollector, part: Extract<HttpOperationPart, { partKind: "tuple" }>, index: number, base: string): PartIR {
  const file = part.body.bodyKind === "file" || isBytes(part.body.type);
  const json = !file && part.body.contentTypes.some(isJsonMediaType) && isStructured(part.body.type);
  return {
    name: part.name ?? `part${index + 1}`, property: `item${index + 1}`, optional: part.optional, multi: part.multi,
    kind: file ? "file" : json ? "json" : "text",
    type: file ? { kind: "file" } : collector.ref(part.body.type, `${base}Part${index + 1}`),
    contentTypes: file ? declaredContentTypes(part.body.contentTypes) : [...part.body.contentTypes],
  };
}

/** Content types a file declares; the `* / *` wildcard of a plain `Http.File` declares none. */
function declaredContentTypes(types: readonly string[]): string[] {
  return types.filter((t) => t !== "*/*");
}

function isJsonLines(contentTypes: readonly string[]): boolean {
  return contentTypes.some((type) => ["application/jsonl", "application/x-ndjson"].includes(type.split(";")[0].trim().toLowerCase()));
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
  // `part.body.type` is already unwrapped past `HttpPart<T>[]` down to `T` (repetition is `PartIR.multi`); apply
  // the part property's own `@encode` to that (via `encodeRef`, not `propertyRef`, which would re-derive the ref
  // from `part.property.type` — `HttpPart<T>[]` for a repeatable part — and wrap it back into an array).
  const type = collector.ref(part.body.type, `${base}${pascal(part.property.name)}`);
  return {
    name: part.name,
    property: part.property.name,
    optional: part.optional,
    multi: part.multi,
    kind: isFile ? "file" : isJson ? "json" : "text",
    type: isFile ? { kind: "file" } : collector.encodeRef(type, part.property),
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
  const events = new Set(types.filter((t) => t.kind === "union" && t.events).map((t) => t.id));
  // @events unions only describe event streams; generated as event types, they have no JSON form.
  const warnEvents = (refs: TypeRef[], where: string, target: () => Type | typeof NoTarget) => {
    for (const id of new Set(refs.flatMap(namedIds))) {
      if (events.has(id)) {
        reportDiagnostic(program, { code: "events-in-json", format: { union: id, where }, target: target() });
      }
    }
  };
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
    if (!(t.kind === "union" && t.events)) warnEvents(refs, `in '${t.id}'`, target);
  }
  for (const [op, ir] of built) {
    const responses = ir.responses.flatMap((r) => (r.body && !r.body.file && !r.body.multipart ? [r.body.type] : []));
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
    const name = getTypeName(op.operation);
    warnEvents(
      [
        ...ir.params.map((p) => p.type),
        ...(ir.body ? [ir.body.type, ...(ir.body.parts ?? []).map((p) => p.type)] : []),
        ...ir.responses.flatMap((r) => [...r.headers.map((h) => h.type), ...(r.body && !r.body.stream ? [r.body.type] : [])]),
      ],
      `'${name}'`,
      () => op.operation,
    );
  }
}

/** Only the single success response of an operation (a fixed status, no response headers) can stream. */
function streamable(program: Program, op: HttpOperation): boolean {
  const success = op.responses.filter((r) => !isErrorModel(program, r.type));
  const contents = success.flatMap((r) => r.responses);
  return (
    contents.length === 1 &&
    typeof success[0].statusCodes === "number" &&
    !contents[0].properties.some((p) => p.kind === "header")
  );
}

interface StreamContext {
  sse: SseLibraries | undefined;
  streamable: boolean;
  /** Set when a text/event-stream response could not stream: it is then a text body (unsupported-sse-response). */
  rejected: boolean;
}

function buildResponses(
  program: Program,
  collector: TypeCollector,
  op: HttpOperation,
  response: HttpOperationResponse,
  base: string,
  multiple: boolean,
  streams: StreamContext,
): ResponseIR[] {
  const codes = response.statusCodes;
  const statusCodes: StatusCodes =
    typeof codes === "number" ? codes : codes === "*" ? "default" : { start: codes.start, end: codes.end };
  const suffix =
    isFixedStatus(statusCodes) ? String(statusCodes) : isDefaultStatus(statusCodes) ? "Default" : String(statusCodes.start);
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
                type: collector.propertyRef(p.property, `${base}${pascal(p.property.name)}`),
                optional: p.property.optional,
              },
            ]
          : [],
      ),
    };
    if (content.body) {
      const eventStream = !isError && isEventStream(content.body.contentTypes);
      const streamable = collector.streamingResponses || streams.streamable;
      if (eventStream && !streamable) streams.rejected = true;
      const stream = eventStream && streamable;
      // Rejected streams keep their declared (string) body: their events union is not collected for them.
      const events = stream ? streamEvents(program, content, streams.sse) : undefined;
      const hint = `${base}Response${multiple ? suffix : ""}`;
      ir.body = {
        type: collector.multipartResponses && content.body.bodyKind === "multipart" ? { kind: "unknown" }
          : collector.ref(events ?? content.body.type, events ? `${base}Events` : hint),
        contentTypes: content.body.contentTypes,
      };
      if (collector.multipartResponses && content.body.bodyKind === "multipart") {
        const body = content.body;
        const parts = body.multipartKind === "model" ? body.parts.map((part) => buildPart(program, collector, part, hint))
          : buildTupleParts(program, collector, body.parts, hint);
        ir.body.type = body.multipartKind === "model" ? collector.ref(body.type, hint)
          : collector.multipartRef(`${getTypeName(op.operation)}:response:${suffix}`, `${hint}Multipart`, parts);
        ir.body.multipart = { parts, tuple: body.multipartKind === "tuple" };
      }
      if (collector.fileResponses && content.body.bodyKind === "file") {
        ir.body.file = { isText: content.body.isText, contentTypes: declaredContentTypes(content.body.contentTypes) };
      }
      const item = collector.jsonLines && isJsonLines(content.body.contentTypes) ? streamElement(program, content.body, streams.sse) : undefined;
      if (item) {
        if (!isError && streamable) ir.body.jsonLines = collector.jsonLinesRef(item, `${base}Item`);
        else reportDiagnostic(program, { code: "unsupported-json-lines", format: { operation: getTypeName(op.operation) }, target: op.operation });
      }
      if (stream) {
        const union = ir.body.type.kind === "named" ? collector.typeOf(ir.body.type.id) : undefined;
        const typed = union?.kind === "union" ? union.events : undefined;
        ir.body.stream = { protocol: "sse", ...(typed ? { events: typed } : {}) };
        if (!events && !streams.sse && declaresStream(program, content)) {
          reportDiagnostic(program, {
            code: "sse-libraries-missing",
            format: { operation: getTypeName(op.operation) },
            target: op.operation,
          });
        }
      }
    }
    return ir;
  });
}
