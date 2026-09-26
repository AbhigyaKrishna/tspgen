import { mergeScopes, metaScopes, type ApiIR, type MetaScopes, type OperationIR, type StatusCodes } from "@abhigyakrishna/tspgen-core";
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
import { nullable } from "./type-map.js";

const UNIT: KtTypeUse = { text: "Unit", imports: [], nullable: false };

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
  if (codes === "default") return "Default";
  if (typeof codes === "number") return STATUS_NAMES[codes] ?? `Status${codes}`;
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
          operations: g.operations.map((op) => this.operation(op, name, groupScopes)),
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
      const type = this.types.typeUse(p.type);
      return {
        name: identifier(camel(p.name)),
        wireName: p.wireName,
        location: p.location,
        type: p.optional ? nullable(type) : type,
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
      ...(r.body ? { body: this.types.typeUse(r.body.type), contentType: r.body.contentTypes[0] ?? "application/json" } : {}),
    }));
    const name = identifier(decoratorArg(op.decorators, "Kotlin.name") ?? camel(op.name));
    const result: KtOperation = {
      id: op.id,
      name,
      verb: op.verb,
      path: op.path,
      ...(op.docs ? { docs: op.docs } : {}),
      annotations: this.types.annotations(op, op.id, scopes),
      meta: scopes,
      params,
      responses,
      result: this.result(plain(name), groupName, responses.filter((r) => !r.isError)),
      errors:
        this.options.errors === "thrown" ? [] : responses.filter((r) => r.isError).map((r) => this.error(r)),
    };
    if (op.body) {
      const taken = new Set(params.map((p) => p.name));
      const preferred = identifier(camel(op.body.name ?? "body"));
      const type = this.types.typeUse(op.body.type);
      result.body = {
        name: taken.has(preferred) ? "requestBody" : preferred,
        type: op.body.optional ? nullable(type) : type,
        contentType: op.body.contentTypes[0] ?? "application/json",
        optional: op.body.optional,
      };
    }
    return result;
  }

  private result(opName: string, groupName: string, success: KtResponse[]): KtResult {
    if (success.length === 0) return { kind: "single", type: UNIT, status: 204 };
    const [only] = success;
    if (success.length === 1 && typeof only.statusCodes === "number" && only.headers.length === 0) {
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
        ...(typeof r.statusCodes === "number" ? { status: r.statusCodes } : {}),
        ...(r.body ? { body: r.body, contentType: r.contentType } : {}),
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
    const base = `${typeName(body.text)}Exception`;
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
    entry.codes.add(typeof r.statusCodes === "number" ? String(r.statusCodes) : JSON.stringify(r.statusCodes));
    error.exception = typeOf(entry.decl);
    return error;
  }
}
