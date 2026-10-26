import { isDefaultStatus, isFixedStatus, mergeScopes, metaScopes, type ApiIR, type MetaScopes, type OperationIR, type TypeRef, type StatusCodes } from "@abhigyakrishna/tspgen-core";
import { camel, identifier, typeName } from "../naming.js";
import type { DeclarationBuilder } from "./declarations.js";
import { decoratorArg } from "./decorators.js";
import { mappedPackage } from "./packages.js";
import type {
  KtApiDecl,
  KtApiExceptionDecl,
  KtError,
  KtExceptionDecl,
  KtOperation,
  KtParam,
  KtResponse,
  KtResult,
  KtResultDecl,
  KtService,
  KtTypeUse,
} from "./model.js";
import { isJsonContentType, nullable } from "./type-map.js";

const UNIT: KtTypeUse = { text: "Unit", imports: [], nullable: false };
const FLOW = "kotlinx.coroutines.flow.Flow";

const STATUS_NAMES: Record<number, string> = {
  200: "Ok",
  201: "Created",
  202: "Accepted",
  203: "NonAuthoritativeInformation",
  204: "NoContent",
  205: "ResetContent",
  206: "PartialContent",
  301: "MovedPermanently",
  302: "Found",
  303: "SeeOther",
  304: "NotModified",
  307: "TemporaryRedirect",
  308: "PermanentRedirect",
};

function variantName(codes: StatusCodes): string {
  if (isDefaultStatus(codes)) return "Default";
  if (isFixedStatus(codes)) return STATUS_NAMES[codes] ?? `Status${codes}`;
  return `Status${Math.floor(codes.start / 100)}xx`;
}

function plain(name: string): string {
  return name.replace(/`/g, "");
}

function typeOf(decl: { name: string; fqn: string }): KtTypeUse {
  return { text: decl.name, imports: [decl.fqn], nullable: false };
}

/** Identity of an error body: the declaration FQN when it is a named declaration, else its text. */
function errorKey(body: KtTypeUse): string {
  const [fqn] = body.imports;
  return body.imports.length === 1 && fqn.endsWith(`.${body.text}`) ? fqn : body.text;
}

/**
 * A valid, stable identifier fragment describing an error body's shape: a named declaration (model, enum,
 * union, user scalar) uses its own name; a container describes its shape instead of its raw type syntax, so
 * `List<Long>` becomes `ListOfLong` rather than the syntactically invalid `ListLong>` `pascal()` would produce.
 */
function bodyTypeName(body: KtTypeUse): string {
  if (body.element) return `ListOf${bodyTypeName(body.element)}`;
  if (body.value) return `MapOf${bodyTypeName(body.value)}`;
  if (body.generic) return `${typeName(body.generic.base.text)}Of${body.generic.args.map(bodyTypeName).join("And")}`;
  return typeName(body.text.replace(/\?$/, ""));
}

export interface ApiOptions {
  errors?: "typed" | "thrown";
  packages?: Record<string, string>;
}

/** Builds Kotlin services plus the shared result/exception declarations they reference. */
export class ApiBuilder {
  private readonly results: KtResultDecl[] = [];
  private readonly exceptions = new Map<string, { decl: KtExceptionDecl; codes: Set<string> }>();
  private readonly apiException: KtApiExceptionDecl;
  private active = false;

  constructor(
    private readonly types: DeclarationBuilder,
    private readonly apiPackage: string,
    private readonly options: ApiOptions = {},
  ) {
    this.apiException = {
      kind: "api-exception",
      id: "$api.ApiException",
      name: "ApiException",
      package: apiPackage,
      fqn: `${apiPackage}.ApiException`,
      annotations: [],
    };
  }

  services(api: ApiIR, basePackage: string): KtService[] {
    this.active = api.services.some((s) => s.groups.length > 0);
    return api.services.map((s) => ({
      id: s.id,
      name: typeName(s.name),
      package: basePackage,
      ...(s.docs ? { docs: s.docs } : {}),
      ...(s.deprecated !== undefined ? { annotations: this.types.annotations({ deprecated: s.deprecated, decorators: {} }, s.id) } : {}),
      servers: s.servers,
      auth: s.auth,
      groups: s.groups.map((g) => {
        const name = decoratorArg(g.decorators, "Kotlin.name") ?? typeName(g.name);
        const groupScopes = [...g.namespaceDecorators.map(metaScopes), metaScopes(g.decorators)].reduce(
          (acc, scopes) => mergeScopes(acc, scopes),
          {} as MetaScopes,
        );
        const pkg = mappedPackage(this.options.packages, g.namespace);
        return {
          id: g.id,
          name,
          namespace: g.namespace,
          ...(pkg ? { package: pkg } : {}),
          ...(g.docs ? { docs: g.docs } : {}),
          annotations: this.types.annotations(g, g.id, groupScopes),
          meta: groupScopes,
          operations: g.operations.map((op) => this.operation({ ...op, deprecated: op.deprecated ?? g.deprecated }, name, groupScopes)),
        };
      }),
    }));
  }

  declarations(): KtApiDecl[] {
    if (!this.active) return [];
    const exceptions = [...this.exceptions.values()].map(({ decl, codes }) => {
      const [only] = codes;
      if (codes.size === 1 && /^\d+$/.test(only)) decl.defaultStatus = Number(only);
      return decl;
    });
    return [this.apiException, ...exceptions, ...this.results];
  }

  private operation(op: OperationIR, groupName: string, groupScopes: MetaScopes): KtOperation {
    const scopes = mergeScopes(groupScopes, metaScopes(op.decorators));
    const params: KtParam[] = op.params.map((p) => {
      const base = this.types.typeUse(p.type);
      const type = p.optional ? nullable(base) : base;
      const name = identifier(camel(p.name));
      const checks = this.types.parameterChecks(p, type, name);
      return {
        name,
        wireName: p.wireName,
        location: p.location,
        type,
        ...(checks.length ? { checks } : {}),
        optional: p.optional,
        explode: p.explode,
        ...(p.docs ? { docs: p.docs } : {}),
      };
    });
    const responses: KtResponse[] = op.responses.map((r) => ({
      statusCodes: r.statusCodes,
      isError: r.isError,
      ...(r.description ? { description: r.description } : {}),
      headers: r.headers.map((h) => {
        const type = this.types.typeUse(h.type);
        return {
          name: identifier(camel(h.name)),
          wireName: h.wireName,
          location: "header" as const,
          type: h.optional ? nullable(type) : type,
          optional: h.optional,
          explode: false,
        };
      }),
      ...(r.body ? this.responseBody(r.body) : {}),
    }));
    const name = identifier(decoratorArg(op.decorators, "Kotlin.name") ?? camel(op.name));
    const result: KtOperation = {
      id: op.id,
      name,
      verb: op.verb,
      path: op.path,
      ...(this.types.operationDocs(op, scopes) ? { docs: this.types.operationDocs(op, scopes) } : {}),
      annotations: this.types.annotations(op, op.id, scopes),
      meta: scopes,
      params,
      responses,
      result: this.result(plain(name), groupName, responses.filter((r) => !r.isError)),
      errors:
        this.options.errors === "thrown" ? [] : responses.filter((r) => r.isError).map((r) => this.error(r)),
      ...(op.auth ? { auth: op.auth } : {}),
    };
    if (op.body) {
      const taken = new Set(params.map((p) => p.name));
      const preferred = identifier(camel(op.body.name ?? "body"));
      const item = op.body.jsonLines ? this.types.typeUse(op.body.jsonLines) : undefined;
      const type = item ? this.flowType(item) : this.wireBodyType(op.body.type, op.body.contentTypes[0] ?? "application/json");
      const body = op.body;
      result.body = {
        name: taken.has(preferred) ? "requestBody" : preferred,
        type: body.optional ? nullable(type) : type,
        contentType: body.contentTypes[0] ?? "application/json",
        optional: body.optional,
        kind: body.kind,
        ...(body.tupleMultipart ? { tupleMultipart: true } : {}),
        ...(item ? { jsonLines: item } : {}),
        ...(body.parts
          ? {
              parts: body.parts.map((p) => ({
                name: body.type.kind === "named" ? this.types.propertyName(body.type.id, p.property) : identifier(camel(p.property)),
                wireName: p.name,
                kind: p.kind,
                multi: p.multi,
                optional: p.optional,
                type: this.types.typeUse(p.type),
                contentTypes: p.contentTypes,
              })),
            }
          : {}),
        ...(body.file ? { file: { isText: body.file.isText, contentTypes: body.file.contentTypes } } : {}),
      };
      if (!item) {
        const checks = this.types.parameterChecks({ name: result.body.name, type: body.type, constraints: body.constraints }, result.body.type, result.body.name);
        if (checks.length) result.body.checks = checks;
      }
    }
    return result;
  }

  private wireBodyType(ref: TypeRef, contentType: string): KtTypeUse {
    if (ref.kind === "nullable") return nullable(this.wireBodyType(ref.of, contentType));
    if (ref.kind === "scalar" && ref.name === "bytes" && !decoratorArg(ref.custom?.decorators, "Kotlin.type") && !isJsonContentType(contentType)) {
      return { text: "ByteArray", imports: [], nullable: false };
    }
    const type = this.types.typeUse(ref);
    return isJsonContentType(contentType) && type.text === "String" ? { ...type, explicitJson: true } : type;
  }

  private responseBody(body: NonNullable<OperationIR["responses"][number]["body"]>): Pick<KtResponse, "body" | "contentType" | "stream"> {
    const contentType = body.contentTypes[0] ?? "application/json";
    if (body.multipart) {
      const type = this.types.typeUse(body.type);
      return { body: { ...type, multipart: { contentType, tuple: body.multipart.tuple, parts: body.multipart.parts.map((part) => ({
        name: body.type.kind === "named" ? this.types.propertyName(body.type.id, part.property) : identifier(camel(part.property)),
        wireName: part.name, kind: part.kind, multi: part.multi, optional: part.optional,
        type: this.types.typeUse(part.type), contentTypes: part.contentTypes,
      })) } }, contentType };
    }
    if (body.jsonLines) {
      const type = this.types.typeUse(body.jsonLines);
      return { body: type, contentType, stream: { protocol: "jsonl", type } };
    }
    if (!body.stream) return { body: this.wireBodyType(body.type, contentType), contentType };
    const stream = this.types.stream(body.stream, body.type);
    return { body: stream.type, contentType, stream };
  }

  private flowType(item: KtTypeUse): KtTypeUse {
    return this.types.hasName("Flow")
      ? { text: `${FLOW}<${item.text}>`, imports: item.imports, nullable: false }
      : { text: `Flow<${item.text}>`, imports: [FLOW, ...item.imports], nullable: false };
  }

  private result(opName: string, groupName: string, success: KtResponse[]): KtResult {
    if (success.length === 0) return { kind: "single", type: UNIT, status: 204 };
    const [only] = success;
    if (success.length === 1 && only.headers.length === 0 && only.stream && isFixedStatus(only.statusCodes)) {
      return {
        kind: "single",
        // Written qualified when a generated type is named Flow (its import would clash).
        type: this.flowType(only.stream.type),
        status: only.statusCodes,
        ...(only.contentType ? { contentType: only.contentType } : {}),
        stream: only.stream,
      };
    }
    if (success.length === 1 && isFixedStatus(only.statusCodes) && only.headers.length === 0) {
      return {
        kind: "single",
        type: only.body ?? UNIT,
        status: only.statusCodes,
        ...(only.contentType ? { contentType: only.contentType } : {}),
      };
    }
    const name = this.resultName(opName, groupName);
    const used = new Set<string>();
    const variants = success.map((r) => {
      const base = variantName(r.statusCodes);
      let vname = base;
      for (let i = 2; used.has(vname); i++) vname = `${base}${i}`;
      used.add(vname);
      return {
        name: vname,
        statusCodes: r.statusCodes,
        ...(isFixedStatus(r.statusCodes) ? { status: r.statusCodes } : {}),
        ...(r.body ? { body: r.stream ? this.flowType(r.stream.type) : r.body, contentType: r.contentType } : {}),
        ...(r.stream ? { stream: r.stream } : {}),
        ...(r.description ? { docs: r.description } : {}),
        headers: r.headers,
      };
    });
    const decl: KtResultDecl = {
      kind: "result",
      id: `$api.${name}`,
      name,
      package: this.apiPackage,
      fqn: `${this.apiPackage}.${name}`,
      annotations: [],
      variants,
    };
    this.results.push(decl);
    return { kind: "sealed", type: typeOf(decl), decl };
  }

  private resultName(opName: string, groupName: string): string {
    const taken = (n: string) => this.results.some((r) => r.name === n) || this.types.hasName(n);
    const base = `${typeName(opName)}Result`;
    if (!taken(base)) return base;
    const qualified = `${groupName}${base}`;
    let name = qualified;
    for (let i = 2; taken(name); i++) name = `${qualified}${i}`;
    return name;
  }

  /** Exception name for an error body; a clash with another model's exception is qualified by its package. */
  private exceptionName(body: KtTypeUse, key: string): string {
    const taken = (n: string) => [...this.exceptions.values()].some((e) => e.decl.name === n);
    const base = `${bodyTypeName(body)}Exception`;
    if (!taken(base)) return base;
    const pkg = key.endsWith(`.${body.text}`) ? key.slice(0, -body.text.length - 1) : "";
    const segment = pkg.split(".").pop() ?? "";
    const qualified = segment ? `${typeName(segment)}${base}` : base;
    let name = qualified;
    for (let i = 2; taken(name); i++) name = `${qualified}${i}`;
    return name;
  }

  private error(r: KtResponse): KtError {
    const error: KtError = {
      statusCodes: r.statusCodes,
      ...(r.body ? { body: r.body, contentType: r.contentType } : {}),
      exception: typeOf(this.apiException),
    };
    if (!r.body) return error;
    const key = errorKey(r.body);
    let entry = this.exceptions.get(key);
    if (!entry) {
      const name = this.exceptionName(r.body, key);
      entry = {
        decl: {
          kind: "exception",
          id: `$api.${name}`,
          name,
          package: this.apiPackage,
          fqn: `${this.apiPackage}.${name}`,
          annotations: [],
          body: r.body,
        },
        codes: new Set(),
      };
      this.exceptions.set(key, entry);
    }
    entry.codes.add(isFixedStatus(r.statusCodes) ? String(r.statusCodes) : JSON.stringify(r.statusCodes));
    error.exception = typeOf(entry.decl);
    return error;
  }
}
