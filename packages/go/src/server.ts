import type { FileSpec, TargetContext } from "@abhigyakrishna/tspgen-core";
import { NoTarget } from "@typespec/compiler";
import { bodyCheck, checkHTTPConfiguration, goFile, modelsDirectory, operationImports, operationUnits, optionalType, parameterCheck, parameterField, requestDeclaration, requestName, typedErrorDeclaration, typedErrors } from "./http.js";
import { nullShape } from "./models-target.js";
import { reportDiagnostic } from "./lib.js";
import { wireOptions, type GoServerOptions } from "./options.js";
import { goOperations, localModuleVersion, typeUse, type GoIR, type GoOperation } from "./transform.js";

type Framework = "nethttp" | "gin";
interface Route { op: GoOperation; path: string; keys: Map<string, string> }

function routes(ops: GoOperation[], ctx: TargetContext, framework: Framework): Route[] {
  const seen = new Set<string>();
  return ops.map((op) => {
    const keys = new Map<string, string>();
    let reason: string | undefined;
    const path = op.path.split("/").map((segment, index) => {
      const match = /^\{([^{}]+)\}$/.exec(segment);
      if (match) {
        if (keys.has(match[1])) reason = "repeated path parameters are not supported";
        keys.set(match[1], `p${index}`);
        return framework === "gin" ? `:p${index}` : segment;
      }
      if (/[{}:*]/.test(segment)) reason = "HTTP routers require path parameters to occupy a whole segment; literal colons and wildcards are not supported";
      return segment;
    }).join("/");
    if (op.params.some((p) => p.location === "path" && !keys.has(p.wireName))) reason ??= "path parameters must have a matching route segment";
    if ([...keys.keys()].some((name) => !op.params.some((p) => p.location === "path" && p.wireName === name))) reason ??= "route placeholders must have a matching path parameter";
    const key = `${op.verb} ${path}`;
    if (seen.has(key)) reason ??= `duplicate ${framework === "gin" ? "Gin" : "HTTP"} route ${key}`;
    seen.add(key);
    if (reason) reportDiagnostic(ctx.program, { code: "unsupported-operation", format: { id: op.id, reason }, target: NoTarget });
    return { op, path, keys };
  });
}

function contract(op: GoOperation, ir: GoIR, ctx: TargetContext, options: GoServerOptions, framework: Framework): string {
  const args = ["ctx context.Context"];
  if (ctx.features.values["call-access"]) args.push(`call *${framework === "gin" ? "gin.Context" : "http.Request"}`);
  if (options["handler-shape"] === "params") {
    args.push(...op.params.map((p) => `${parameterField(p, ir).replace(/^./, (c) => c.toLowerCase())} ${optionalType(typeUse(p.type, ir), p.optional)}`));
    if (op.body) args.push(`body ${optionalType(typeUse(op.body.type, ir), op.body.optional)}`);
  } else args.push(`request ${requestName(op, options)}`);
  return `\t${op.name}(${args.join(", ")}) (${op.success.body ? `${typeUse(op.success.body.type, ir).text}, ` : ""}error)`;
}

function handler(route: Route, ir: GoIR, ctx: TargetContext, options: GoServerOptions, framework: Framework): string {
  const { op } = route;
  const gin = framework === "gin";
  const wire = wireOptions(ctx, ir);
  const reject = gin ? "reject(c," : "rejectHTTP(w,";
  const out = [gin
    ? `\trouter.Handle(${JSON.stringify(op.verb)}, escapedRoute(${JSON.stringify(route.path)}), func(c *gin.Context) {`
    : `\trouter.HandleFunc(${JSON.stringify(`${op.verb} ${route.path}`)}, func(w http.ResponseWriter, r *http.Request) {`,
  ...(options["handler-shape"] !== "params" || op.params.length || op.body ? [`\t\tvar request ${requestName(op, options)}`] : [])];
  for (const p of op.params) {
    const field = parameterField(p, ir);
    out.push("\t\t{");
    if (p.location === "path" && gin) out.push(`\t\t\traw, err := pathValue(c, ${JSON.stringify(route.keys.get(p.wireName))})`, `\t\t\tif err != nil { ${reject} http.StatusBadRequest, "invalid path parameter"); return }`, "\t\t\tpresent := true");
    else {
      const request = gin ? "c.Request" : "r";
      const raw = p.location === "path" ? `r.PathValue(${JSON.stringify(p.wireName)})` : p.location === "query" ? `${request}.URL.Query().Get(${JSON.stringify(p.wireName)})` : `${request}.Header.Get(${JSON.stringify(p.wireName)})`;
      const present = p.location === "path" ? "true" : p.location === "query" ? `${request}.URL.Query().Has(${JSON.stringify(p.wireName)})` : `${request}.Header.Values(${JSON.stringify(p.wireName)}) != nil`;
      out.push(`\t\t\traw := ${raw}`, `\t\t\tpresent := ${present}`);
    }
    out.push("\t\t\tif present {", `\t\t\t\tif err := models.DecodeParameter(raw, &request.${field}); err != nil { ${reject} http.StatusBadRequest, "invalid ${p.location} parameter"); return }`, `\t\t\t} ${p.optional ? "" : `else { ${reject} http.StatusBadRequest, "missing ${p.location} parameter"); return }`}`, "\t\t}");
  }
  parameterCheck(op, ir).forEach((check, index) => {
    if (wire.validate || op.params[index].type.kind === "literal") out.push(`\t\t${check} { ${reject} http.StatusBadRequest, "invalid ${op.params[index].location} parameter"); return }`);
  });
  if (op.body) {
    out.push(`\t\tif !${gin ? "readJSONBody(c" : "readHTTPJSON(w, r"}, &request.Body, ${op.body.optional}, ${op.body.type.kind === "nullable" || op.body.type.kind === "unknown"}, ${JSON.stringify(nullShape(op.body.type))}) { return }`);
    if (wire.validate) out.push(`\t\t${bodyCheck(op, ir)} { ${reject} http.StatusBadRequest, "invalid JSON body"); return }`);
  }
  const args = [gin ? "c.Request.Context()" : "r.Context()"];
  if (ctx.features.values["call-access"]) args.push(gin ? "c" : "r");
  if (options["handler-shape"] === "params") {
    args.push(...op.params.map((p) => `request.${parameterField(p, ir)}`));
    if (op.body) args.push("request.Body");
  } else args.push("request");
  out.push(`\t\t${op.success.body ? "result, err" : "err"} := service.${op.name}(${args.join(", ")})`, `\t\tif err != nil { ${gin ? "serviceError(c" : "serviceHTTPError(w"}, err); return }`);
  if (op.success.body) out.push(`\t\t${gin ? "writeJSON(c" : "writeHTTPJSON(w"}, ${op.status}, result)`);
  else out.push(`\t\t${gin ? `c.Status(${op.status})` : `w.WriteHeader(${op.status})`}`);
  out.push("\t})");
  return out.join("\n");
}

function runtime(ir: GoIR, ctx: TargetContext, options: GoServerOptions, framework: Framework): string {
  const wire = wireOptions(ctx, ir);
  const fallback = options["error-body"] ?? "json";
  const out = [`type HTTPError struct { StatusCode int; Body any }`,
    `func (e *HTTPError) Error() string { if e == nil { return "nil HTTPError" }; return fmt.Sprintf("HTTP %d", e.StatusCode) }`,
    `func (e *HTTPError) HTTPStatus() int { if e == nil { return 500 }; return e.StatusCode }`,
    `func (e *HTTPError) HTTPBody() any { if e == nil { return nil }; return e.Body }`,
    `func rejectHTTP(w http.ResponseWriter, status int, message string) {`,
    ...(fallback === "none" ? ["w.WriteHeader(status)"] : [
      fallback === "problem" ? `body := map[string]any{"type": "about:blank", "title": http.StatusText(status), "status": status, "detail": message}` : `body := map[string]string{"error": message}`,
      "payload, _ := models.EncodeJSON(body, true, true)", `w.Header().Set("Content-Type", ${JSON.stringify(fallback === "problem" ? "application/problem+json" : "application/json")})`, "w.WriteHeader(status)", "_, _ = w.Write(payload)",
    ]), "}",
    `func writeHTTPJSON(w http.ResponseWriter, status int, body any) error {`,
    `payload, err := models.EncodeJSON(body, ${wire.encodeDefaults}, ${wire.explicitNulls})`,
    `if err != nil { rejectHTTP(w, http.StatusInternalServerError, http.StatusText(http.StatusInternalServerError)); return err }`,
    `w.Header().Set("Content-Type", "application/json")`, "w.WriteHeader(status)", "_, err = w.Write(payload)", "return err", "}",
    `func serviceHTTPError(w http.ResponseWriter, err error) {`,
    `var statusErr interface { error; HTTPStatus() int; HTTPBody() any }`,
    `if errors.As(err, &statusErr) && statusErr != nil {`,
    `value := reflect.ValueOf(statusErr)`,
    `if value.Kind() != reflect.Pointer || !value.IsNil() { status := statusErr.HTTPStatus(); if status >= 400 && status <= 599 { writeHTTPJSON(w, status, statusErr.HTTPBody()); return } }`, "}",
    `rejectHTTP(w, http.StatusInternalServerError, http.StatusText(http.StatusInternalServerError))`, "}",
    `func readHTTPJSON(w http.ResponseWriter, r *http.Request, target any, optional, nullable bool, shape string) bool {`,
    "reader := r.Body", "if reader == nil { reader = http.NoBody }",
    `body, err := io.ReadAll(http.MaxBytesReader(w, reader, ${options["max-body-size"] ?? 1048576}))`,
    `if err != nil { var sizeErr *http.MaxBytesError; if errors.As(err, &sizeErr) { rejectHTTP(w, http.StatusRequestEntityTooLarge, "request body too large") } else { rejectHTTP(w, http.StatusBadRequest, "invalid JSON body") }; return false }`,
    "body = bytes.TrimSpace(body)",
    `if len(body) == 0 { if optional { return true }; rejectHTTP(w, http.StatusBadRequest, "missing JSON body"); return false }`,
    `mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))`,
    `if err != nil || (mediaType != "application/json" && !(strings.HasPrefix(mediaType, "application/") && strings.HasSuffix(mediaType, "+json"))) { rejectHTTP(w, http.StatusUnsupportedMediaType, "expected JSON content type"); return false }`,
    `if !nullable && bytes.Equal(body, []byte("null")) { rejectHTTP(w, http.StatusBadRequest, "invalid JSON body"); return false }`,
    `if err := models.DecodeJSON(body, target, ${wire.ignoreUnknown}, ${wire.validate}, ${wire.defaults}, shape); err != nil { rejectHTTP(w, http.StatusBadRequest, "invalid JSON body"); return false }`, "return true", "}",
  ];
  const service = options["service-name"] ?? "Service";
  if (framework === "gin") out.push(
    ...(ctx.features.values.handler ? [`func NewHandler(service ${service}) *gin.Engine { router := gin.New(); router.Use(gin.Recovery()); router.UseEscapedPath = true; router.UnescapePathValues = false; router.HandleMethodNotAllowed = true; RegisterRoutes(router, service); return router }`] : []),
    `func escapedRoute(path string) string { return (&url.URL{Path: path}).EscapedPath() }`,
    `func pathValue(c *gin.Context, key string) (string, error) { pattern := strings.Split(c.FullPath(), "/"); path := strings.Split(c.Request.URL.EscapedPath(), "/"); for i := len(pattern) - 1; i >= 0; i-- { if pattern[i] == ":" + key && i < len(path) { return url.PathUnescape(path[i]) } }; return "", errors.New("missing path parameter") }`,
    `func reject(c *gin.Context, status int, message string) { c.Abort(); rejectHTTP(c.Writer, status, message) }`,
    `func writeJSON(c *gin.Context, status int, body any) { if err := writeHTTPJSON(c.Writer, status, body); err != nil { _ = c.Error(err); c.Abort() } }`,
    `func serviceError(c *gin.Context, err error) { _ = c.Error(err); c.Abort(); serviceHTTPError(c.Writer, err) }`,
    `func readJSONBody(c *gin.Context, target any, optional, nullable bool, shape string) bool { if !readHTTPJSON(c.Writer, c.Request, target, optional, nullable, shape) { c.Abort(); return false }; return true }`,
  );
  else if (ctx.features.values.handler) out.push(`func NewHandler(service ${service}) http.Handler { router := http.NewServeMux(); RegisterRoutes(router, service); return router }`);
  return out.join("\n\n");
}

export function goServerFiles(ir: GoIR, ctx: TargetContext, framework: Framework): FileSpec[] {
  const options = ctx.options as unknown as GoServerOptions;
  const ops = goOperations(ctx.program, ir);
  const allRoutes = routes(ops, ctx, framework);
  const pkg = options.package ?? "server";
  const version = checkHTTPConfiguration(ir, ctx, options, pkg, framework === "gin" ? "1.25.0" : "1.22");
  if (options.module === "github.com/gin-gonic/gin") throw new Error("The server module must differ from the Gin module.");
  const service = options["service-name"] ?? "Service";
  const router = framework === "gin" ? "gin.IRoutes" : "*http.ServeMux";
  const grouped = options.grouping && options.grouping !== "single-file";
  const units = grouped ? operationUnits(ops, ir, options.grouping) : [];
  const reserved = new Set([service, "HTTPError", "NewHandler", "RegisterRoutes", "rejectHTTP", "writeHTTPJSON", "serviceHTTPError", "readHTTPJSON", "escapedRoute", "pathValue", "reject", "writeJSON", "serviceError", "readJSONBody"]);
  const reserve = (name: string) => { if (reserved.has(name)) throw new Error(`Generated Go server identifier ${name} conflicts with another declaration.`); reserved.add(name); };
  if (service !== "Service" && ["HTTPError", "NewHandler", "RegisterRoutes"].includes(service)) throw new Error(`service-name ${service} conflicts with server runtime.`);
  const errors = new Map(ops.map((op) => [op.id, options.errors === "typed" ? typedErrors(op, ir, ctx) : []]));
  for (const op of ops) { reserve(requestName(op, options)); for (const error of errors.get(op.id)!) reserve(error.name); }
  for (const unit of units) { reserve(`${unit.name}${service}`); reserve(`Register${unit.name}Routes`); }
  const operationBody = (operations: GoOperation[], name: string, register: string) => {
    const typed = operations.flatMap((op) => errors.get(op.id)!);
    const body = [
      ...operations.map((op) => requestDeclaration(op, ir, options)), ...typed.map((e) => typedErrorDeclaration(e, ir, false)),
      `type ${name} interface {\n${operations.map((op) => contract(op, ir, ctx, options, framework)).join("\n")}\n}`,
      ...(framework === "gin" ? ["// Configure the engine with UseEscapedPath = true before mounting these routes."] : []),
      `func ${register}(router ${router}, service ${name}) {`, ...allRoutes.filter((r) => operations.includes(r.op)).map((r) => handler(r, ir, ctx, options, framework)), "}",
    ].join("\n\n");
    return { body, imports: [...(body.includes("http.") ? ["net/http"] : []), ...(framework === "gin" ? ["github.com/gin-gonic/gin"] : []), ...(operations.length ? ["context"] : []), ...(body.includes("models.") ? [ir.module] : []), ...(typed.length ? ["fmt"] : []), ...operationImports(operations, ir), ...typed.flatMap((e) => e.body ? typeUse(e.body, ir).imports ?? [] : [])] };
  };
  const files: FileSpec[] = [];
  if (ctx.features.values["go-mod"]) files.push({ path: "server/go.mod", template: framework === "gin" ? "gin/mod" : "go/dependent-mod", data: { module: options.module, goVersion: version, modelsModule: ir.module, modelsVersion: localModuleVersion(ir.module), modelsDir: modelsDirectory(ctx, "server") } });
  const imports = ["bytes", "errors", "fmt", "io", "mime", "net/http", "reflect", "strings", ir.module, ...(framework === "gin" ? ["net/url", "github.com/gin-gonic/gin"] : [])];
  let body = runtime(ir, ctx, options, framework);
  if (grouped) {
    body += `\n\ntype ${service} interface {\n${units.map((u) => `\t${u.name}${service}`).join("\n")}\n}\n\nfunc RegisterRoutes(router ${router}, service ${service}) {\n${units.map((u) => `\tRegister${u.name}Routes(router, service)`).join("\n")}\n}`;
    for (const unit of units) { const part = operationBody(unit.operations, `${unit.name}${service}`, `Register${unit.name}Routes`); files.push(goFile(`server/${unit.file}_operations.go`, part.body, part.imports, ir, pkg)); }
  } else { const part = operationBody(ops, service, "RegisterRoutes"); body += `\n\n${part.body}`; imports.push(...part.imports); }
  files.push(goFile("server/server.go", body, imports, ir, pkg));
  if (ctx.program.hasError()) throw new Error("Cannot generate Go server; see the reported diagnostics.");
  return files;
}
