import type { ApiIR, OperationIR, StatusCodes } from "@abhigyakrishna/tspgen-core";
import { decoratorArg, mergeScopes, metaScopes, type MetaScopes } from "@abhigyakrishna/tspgen-core";
import { camel, typeName } from "../naming.js";
import { constrain } from "./constraints.js";
import type { DeclarationBuilder } from "./declarations.js";
import type {
  TsError,
  TsErrorClass,
  TsHeader,
  TsOperation,
  TsParam,
  TsResult,
  TsResultDecl,
  TsResultVariant,
  TsService,
  TsTypeUse,
} from "./model.js";
import { VOID } from "./type-map.js";

const ERRORS_FILE = "api/errors";
const RESULTS_FILE = "api/results";

function classUse(name: string): TsTypeUse {
  return { text: name, imports: [{ name, from: ERRORS_FILE, typeOnly: false, root: "models" }], schema: "", schemaImports: [] };
}

export const HTTP_ERROR = classUse("HttpError");

interface Response {
  statusCodes: StatusCodes;
  isError: boolean;
  body?: TsTypeUse;
  contentType?: string;
  headers: TsHeader[];
}

/** Builds TS services plus the shared result unions and error classes they reference. */
export class ApiBuilder {
  readonly results: TsResultDecl[] = [];
  private readonly errorClasses = new Map<string, TsErrorClass>();
  active = false;

  constructor(
    private readonly types: DeclarationBuilder,
    private readonly options: { errors?: "typed" | "thrown" } = {},
  ) {}

  services(api: ApiIR): TsService[] {
    this.active = api.services.some((s) => s.groups.length > 0);
    return api.services.map((s) => ({
      id: s.id,
      name: typeName(s.name),
      ...(s.docs ? { docs: s.docs } : {}),
      auth: s.auth,
      groups: s.groups.map((g) => {
        const name = decoratorArg(g.decorators, "TS.name") ?? typeName(g.name);
        const groupScopes = metaScopes(g.decorators);
        return {
          id: g.id,
          name,
          ...(g.docs ? { docs: g.docs } : {}),
          meta: groupScopes,
          operations: g.operations.map((op) => this.operation(op, name, groupScopes)),
        };
      }),
    }));
  }

  errors(): TsErrorClass[] {
    return [...this.errorClasses.values()];
  }

  private operation(op: OperationIR, groupName: string, groupScopes: MetaScopes): TsOperation {
    const params: TsParam[] = op.params.map((p) => {
      const plain = this.types.typeUse(p.type);
      const type = constrain(plain, p.constraints, false, (pattern) => this.types.invalidPattern(pattern, `${op.id}.${p.name}`));
      return {
        name: camel(p.name),
        wireName: p.wireName,
        location: p.location,
        type,
        constrained: type !== plain,
        optional: p.optional,
        explode: p.explode,
        ...(p.docs ? { docs: p.docs } : {}),
      };
    });
    const responses: Response[] = op.responses.map((r) => ({
      statusCodes: r.statusCodes,
      isError: r.isError,
      ...(r.body ? { body: this.types.typeUse(r.body.type), contentType: r.body.contentTypes[0] ?? "application/json" } : {}),
      headers: r.headers.map((h) => ({
        name: camel(h.name),
        wireName: h.wireName,
        type: this.types.typeUse(h.type),
        optional: h.optional,
      })),
    }));
    const name = decoratorArg(op.decorators, "TS.name") ?? camel(op.name);
    const result: TsOperation = {
      id: op.id,
      name,
      verb: op.verb,
      path: op.path,
      ...(op.docs ? { docs: op.docs } : {}),
      ...(op.deprecated ? { deprecated: op.deprecated } : {}),
      meta: mergeScopes(groupScopes, metaScopes(op.decorators)),
      params,
      result: this.result(name, groupName, responses.filter((r) => !r.isError)),
      errors: this.options.errors === "thrown" ? [] : responses.filter((r) => r.isError).map((r) => this.error(r)),
      ...(op.auth ? { auth: op.auth } : {}),
    };
    if (op.body) {
      const preferred = camel(op.body.name ?? "body");
      result.body = {
        name: params.some((p) => p.name === preferred) ? "requestBody" : preferred,
        ...(op.body.docs ? { docs: op.body.docs } : {}),
        type: constrain(this.types.typeUse(op.body.type), op.body.constraints, false, (pattern) =>
          this.types.invalidPattern(pattern, `${op.id}.${op.body?.name ?? "body"}`),
        ),
        contentType: op.body.contentTypes[0] ?? "application/json",
        optional: op.body.optional,
        kind: op.body.kind,
      };
      const bodyType = op.body.type;
      if (op.body.parts) {
        result.body.parts = op.body.parts.map((p) => ({
          name: p.name,
          key: bodyType.kind === "named" ? this.types.propertyWireName(bodyType.id, p.property) : p.property,
          kind: p.kind,
          multi: p.multi,
          optional: p.optional,
          type: this.types.typeUse(p.type),
          contentTypes: p.contentTypes,
        }));
      }
      if (op.body.file) result.body.file = { isText: op.body.file.isText, contentTypes: op.body.file.contentTypes };
    }
    return result;
  }

  private result(opName: string, groupName: string, success: Response[]): TsResult {
    if (success.length === 0) return { kind: "single", type: VOID, status: 204 };
    const [only] = success;
    if (success.length === 1 && typeof only.statusCodes === "number" && only.headers.length === 0) {
      return {
        kind: "single",
        type: only.body ?? VOID,
        status: only.statusCodes,
        ...(only.contentType ? { contentType: only.contentType } : {}),
      };
    }
    const name = this.resultName(opName, groupName);
    const variants: TsResultVariant[] = success.map((r) => ({
      statusCodes: r.statusCodes,
      ...(typeof r.statusCodes === "number" ? { status: r.statusCodes } : {}),
      ...(r.body ? { body: r.body, contentType: r.contentType } : {}),
      headers: r.headers,
    }));
    const decl: TsResultDecl = { name, file: RESULTS_FILE, variants };
    this.results.push(decl);
    return {
      kind: "union",
      type: { text: name, imports: [{ name, from: RESULTS_FILE, typeOnly: true, root: "models" }], schema: "", schemaImports: [] },
      decl,
    };
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

  private error(r: Response): TsError {
    const error: TsError = {
      statusCodes: r.statusCodes,
      ...(r.body ? { body: r.body, contentType: r.contentType } : {}),
      errorClass: HTTP_ERROR,
    };
    if (!r.body) return error;
    let cls = this.errorClasses.get(r.body.text);
    if (!cls) {
      cls = { name: `${typeName(r.body.text)}Error`, file: ERRORS_FILE, body: r.body };
      this.errorClasses.set(r.body.text, cls);
    }
    error.errorClass = classUse(cls.name);
    return error;
  }
}
