import type { FileSpec, Target, TargetContext } from "@abhigyakrishna/tspgen-core";
import { goName, goOperations, goType, localModuleVersion, validModule, validPackage, reportDiagnostic, type GoIR, type GoOperation, type GoType } from "@abhigyakrishna/tspgen-go";
import { NoTarget } from "@typespec/compiler";
import { relative, resolve, sep } from "node:path";

interface Options { module: string; package?: string }

const optionsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    module: { type: "string", description: "Import path of the generated Go server module." },
    package: { type: "string", default: "server", description: "Go package name of generated server files." },
  },
  required: ["module"],
};

function fieldType(type: GoType, optional: boolean): string {
  return optional && !type.pointer && type.text !== "any" ? `*${type.text}` : type.text;
}

function requestFields(op: GoOperation, ir: GoIR): string[] {
  const params = op.params.map((p) => `\t${goName(`${p.location} ${p.name}`)} ${fieldType(goType(p.type, ir.api, "models."), p.optional)}`);
  if (op.body) params.push(`\tBody ${fieldType(goType(op.body.type, ir.api, "models."), op.body.optional)}`);
  return params;
}

function stringParam(name: string): boolean {
  return ["string", "url", "utcDateTime", "offsetDateTime", "plainDate", "plainTime", "duration"].includes(name);
}

function readParam(op: GoOperation, p: GoOperation["params"][number]): string[] {
  const field = goName(`${p.location} ${p.name}`);
  const raw = p.location === "path" ? `r.PathValue(${JSON.stringify(p.wireName)})` :
    p.location === "query" ? `r.URL.Query().Get(${JSON.stringify(p.wireName)})` : `r.Header.Get(${JSON.stringify(p.wireName)})`;
  const present = p.location === "path" ? "raw != \"\"" :
    p.location === "query" ? `r.URL.Query().Has(${JSON.stringify(p.wireName)})` : `r.Header.Values(${JSON.stringify(p.wireName)}) != nil`;
  const encoded = p.type.kind === "scalar" && (stringParam(p.type.name) || p.type.encoding === "string") ? `[]byte(strconv.Quote(raw))` : `[]byte(raw)`;
  return [
    `\t{`,
    `\t\traw := ${raw}`,
    `\t\tif ${present} {`,
    `\t\t\tif err := json.Unmarshal(${encoded}, &request.${field}); err != nil { http.Error(w, "invalid ${p.location} parameter", http.StatusBadRequest); return }`,
    `\t\t} ${p.optional ? "" : `else { http.Error(w, "missing ${p.location} parameter", http.StatusBadRequest); return }`}`,
    `\t}`,
  ];
}

function handler(op: GoOperation, ir: GoIR): string {
  const response = op.success.body ? goType(op.success.body.type, ir.api, "models.").text : undefined;
  const out = [
    `\tmux.HandleFunc(${JSON.stringify(`${op.verb} ${op.path}`)}, func(w http.ResponseWriter, r *http.Request) {`,
    `\t\tvar request ${op.name}Request`,
  ];
  for (const p of op.params) out.push(...readParam(op, p).map((line) => `\t${line}`));
  if (op.body) out.push(
    `\t\tif err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&request.Body); err != nil ${op.body.optional ? "&& err != io.EOF " : ""}{`,
    `\t\t\thttp.Error(w, "invalid JSON body", http.StatusBadRequest); return`,
    `\t\t}`,
  );
  out.push(
    `\t\t${response ? "result, err" : "err"} := service.${op.name}(r.Context(), request)`,
    `\t\tif err != nil {`,
    `\t\t\tvar statusErr *HTTPError`,
    `\t\t\tif errors.As(err, &statusErr) {`,
    `\t\t\t\twriteError(w, statusErr)`,
    `\t\t\t} else {`,
    `\t\t\t\thttp.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)`,
    `\t\t\t}`,
    `\t\t\treturn`,
    `\t\t}`,
  );
  if (response) out.push(
    `\t\tpayload, err := json.Marshal(result)`,
    `\t\tif err != nil { http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError); return }`,
    `\t\tw.Header().Set("Content-Type", "application/json")`,
    `\t\tw.WriteHeader(${op.status})`,
    `\t\t_, _ = w.Write(payload)`,
  );
  else out.push(`\t\tw.WriteHeader(${op.status})`);
  out.push(`\t})`);
  return out.join("\n");
}

function serverBody(ir: GoIR, ctx: TargetContext): string {
  const operations = goOperations(ctx.program, ir);
  const requests = operations.map((op) => [`type ${op.name}Request struct {`, ...requestFields(op, ir), "}"].join("\n"));
  const signatures = operations.map((op) => {
    const response = op.success.body ? `${goType(op.success.body.type, ir.api, "models.").text}, ` : "";
    return `\t${op.name}(ctx context.Context, request ${op.name}Request) (${response}error)`;
  });
  const handlers = operations.map((op) => handler(op, ir));
  const imports = ["encoding/json", "fmt", "net/http"];
  if (operations.length) imports.push("context", "errors");
  if (operations.some((op) => op.body)) imports.push("io");
  if (operations.some((op) => op.params.some((p) => p.type.kind === "scalar" && (stringParam(p.type.name) || p.type.encoding === "string")))) imports.push("strconv");
  if ([...requests, ...signatures].some((s) => s.includes("models."))) imports.push(ir.module);
  imports.sort();
  const rendered = imports.map((name) => name === ir.module ? `\tmodels ${JSON.stringify(name)}` : `\t${JSON.stringify(name)}`);
  return [
    `import (`, ...rendered, `)`,
    ``,
    `type Service interface {`, ...signatures, `}`,
    ``,
    `type HTTPError struct {`, `\tStatusCode int`, `\tBody any`, `}`,
    ``,
    `func (e *HTTPError) Error() string { return fmt.Sprintf("HTTP %d", e.StatusCode) }`,
    ``,
    `func writeError(w http.ResponseWriter, e *HTTPError) {`,
    `\tstatus := e.StatusCode`,
    `\tif status < 400 || status > 599 { status = http.StatusInternalServerError }`,
    `\tpayload, err := json.Marshal(e.Body)`,
    `\tif err != nil { http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError); return }`,
    `\tw.Header().Set("Content-Type", "application/json")`,
    `\tw.WriteHeader(status)`,
    `\t_, _ = w.Write(payload)`,
    `}`,
    ...requests.flatMap((s) => ["", s]),
    ``,
    `func NewHandler(service Service) http.Handler {`,
    `\tmux := http.NewServeMux()`,
    ...handlers,
    `\treturn mux`,
    `}`,
  ].join("\n");
}

export const goNethttpServerTarget: Target<GoIR> = {
  name: "@abhigyakrishna/tspgen-go-nethttp-server",
  kind: "server",
  language: "go",
  optionsSchema,
  files: (ir, ctx): FileSpec[] => {
    const options = ctx.options as unknown as Options;
    const packageName = options.package ?? "server";
    if (!validModule(options.module)) reportDiagnostic(ctx.program, { code: "invalid-module", format: { name: String(options.module) }, target: NoTarget });
    if (!validPackage(packageName)) reportDiagnostic(ctx.program, { code: "invalid-package", format: { name: packageName }, target: NoTarget });
    const modelsDir = relative(resolve(ctx.outputDir, "server"), resolve(ctx.modelsOutputDir, "models")).split(sep).join("/");
    return [
      { path: "server/go.mod", template: "go/dependent-mod", data: { module: options.module, modelsModule: ir.module, modelsVersion: localModuleVersion(ir.module), modelsDir: modelsDir.startsWith(".") ? modelsDir : `./${modelsDir}` } },
      { path: "server/server.go", template: "go/file", data: { package: packageName, body: serverBody(ir, ctx) } },
    ];
  },
};

export default goNethttpServerTarget;
