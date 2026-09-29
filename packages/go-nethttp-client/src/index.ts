import type { FileSpec, Target, TargetContext } from "@abhigyakrishna/tspgen-core";
import {
  atLeastGo, bodyCheck, checkHTTPConfiguration, goClientFeatures, goClientOptionsSchema, goFile, goOperations, nullShape,
  localModuleVersion, matchesStatus, modelsDirectory, operationImports, operationUnits, parameterCheck,
  parameterField, requestDeclaration, requestName, typedErrorDeclaration, typedErrors, typeUse, wireOptions,
  type GoClientOptions, type GoIR, type GoOperation, type TypedHTTPError,
} from "@abhigyakrishna/tspgen-go";

function method(op: GoOperation, ir: GoIR, ctx: TargetContext, options: GoClientOptions, errors: TypedHTTPError[]): string {
  const response = op.success.body ? typeUse(op.success.body.type, ir).text : undefined;
  const ret = response ? "return result, err" : "return err";
  const wire = wireOptions(ctx, ir);
  const name = options["client-name"] ?? "Client";
  const out = [
    ...(op.docs?.split("\n").map((line) => `// ${line}`) ?? []),
    `func (c *${name}) ${op.name}(ctx context.Context, request ${requestName(op, options)}) ${response ? `(result ${response}, err error)` : `(err error)`} {`,
  ];
  if (wire.validate) {
    for (const check of parameterCheck(op, ir)) out.push(`\t${check} { ${ret} }`);
    if (op.body) out.push(`\t${bodyCheck(op, ir)} { ${ret} }`, `\tif validationErr := models.ValidateValue(request.Body); validationErr != nil { err = validationErr; ${ret} }`);
  }
  out.push(`\tpath := ${JSON.stringify(op.path)}`);
  for (const p of op.params.filter((p) => p.location === "path")) out.push(
    `\t{`, `\t\traw, encodeErr := models.EncodeParameter(request.${parameterField(p, ir)})`,
    `\t\tif encodeErr != nil { err = encodeErr; ${ret} }`,
    `\t\tpath = strings.ReplaceAll(path, ${JSON.stringify(`{${p.wireName}}`)}, url.PathEscape(raw))`, `\t}`,
  );
  out.push(`\tu, err := url.Parse(strings.TrimRight(c.BaseURL, "/") + path)`, `\tif err != nil { ${ret} }`, `\tquery := u.Query()`);
  for (const p of op.params.filter((p) => p.location === "query")) {
    const field = `request.${parameterField(p, ir)}`;
    out.push(`\t${p.optional ? `if ${field} != nil {` : "{"}`, `\t\traw, encodeErr := models.EncodeParameter(${field})`, `\t\tif encodeErr != nil { err = encodeErr; ${ret} }`, `\t\tquery.Set(${JSON.stringify(p.wireName)}, raw)`, `\t}`);
  }
  out.push(`\tu.RawQuery = query.Encode()`, `\tvar body io.Reader`);
  if (op.body) {
    if (op.body.optional) out.push(`\tif request.Body != nil {`);
    out.push(`\tpayload, marshalErr := models.EncodeJSON(request.Body, ${wire.encodeDefaults}, ${wire.explicitNulls})`, `\tif marshalErr != nil { err = marshalErr; ${ret} }`, `\tbody = bytes.NewReader(payload)`);
    if (op.body.optional) out.push(`\t}`);
  }
  out.push(`\treq, err := http.NewRequestWithContext(ctx, ${JSON.stringify(op.verb)}, u.String(), body)`, `\tif err != nil { ${ret} }`);
  if (op.body) out.push(`\tif body != nil { req.Header.Set("Content-Type", "application/json") }`);
  for (const p of op.params.filter((p) => p.location === "header")) {
    const field = `request.${parameterField(p, ir)}`;
    out.push(`\t${p.optional ? `if ${field} != nil {` : "{"}`, `\t\traw, encodeErr := models.EncodeParameter(${field})`, `\t\tif encodeErr != nil { err = encodeErr; ${ret} }`, `\t\treq.Header.Set(${JSON.stringify(p.wireName)}, raw)`, `\t}`);
  }
  const shape = JSON.stringify(op.success.body ? nullShape(op.success.body.type) : "?_");
  if (ctx.features.values["generic-methods"]) out.push(response ? `\tresult, err = c.Do[${response}](req, ${op.status}, true, ${shape})` : `\t_, err = c.Do[struct{}](req, ${op.status}, false)`);
  else out.push(`\terr = c.do(req, ${op.status}, ${response ? "&result" : "nil"}, ${shape})`);
  if (errors.length) {
    out.push(`\tif err != nil {`, `\t\tvar rawError *HTTPError`, `\t\tif errors.As(err, &rawError) {`);
    for (const error of [...errors].sort((a, b) => Number(a.response.statusCodes === "default") - Number(b.response.statusCodes === "default"))) {
      out.push(`\t\t\tif ${matchesStatus(error, "rawError.StatusCode")} {`, `\t\t\t\ttyped := &${error.name}{StatusCode: rawError.StatusCode, Cause: rawError}`);
      if (error.body) out.push(`\t\t\t\tif decodeErr := models.DecodeJSON(rawError.Body, &typed.Body, ${wire.ignoreUnknown}, ${wire.validate}, ${wire.defaults}, ${JSON.stringify(nullShape(error.body))}); decodeErr != nil { err = fmt.Errorf("decode error response: %w", decodeErr); ${ret} }`);
      out.push(`\t\t\t\terr = typed`, `\t\t\t\t${ret}`, `\t\t\t}`);
    }
    out.push(`\t\t}`, `\t}`);
  }
  out.push(`\t${ret}`, `}`);
  return out.join("\n");
}

function runtime(ir: GoIR, ctx: TargetContext, options: GoClientOptions): { body: string; imports: string[] } {
  const name = options["client-name"] ?? "Client";
  const generic = ctx.features.values["generic-methods"] === true;
  const wire = wireOptions(ctx, ir);
  const timeout = options["timeout-ms"] ?? 0;
  const size = options["max-response-size"] ?? 1048576;
  const ret = generic ? "return result, err" : "return err";
  const out = [
    `type ${name} struct {`, `\tBaseURL string`, `\tHTTPClient *http.Client`, `}`, "",
    `type HTTPError struct {`, `\tStatusCode int`, `\tBody []byte`, `}`, "",
    `func (e *HTTPError) Error() string { return fmt.Sprintf("HTTP %d: %s", e.StatusCode, e.Body) }`,
  ];
  if (ctx.features.values["client-constructor"]) out.push("", `func New${name}(baseURL string) *${name} { return &${name}{BaseURL: baseURL} }`);
  out.push("", generic ? `// Do sends an HTTP request and decodes its expected success body as T.\nfunc (c *${name}) Do[T any](req *http.Request, successStatus int, decodeBody bool, shape ...string) (result T, err error) {` : `func (c *${name}) do(req *http.Request, successStatus int, target any, shape string) (err error) {`,
    `\thttpClient := c.HTTPClient`, `\tif httpClient == nil { httpClient = ${timeout ? `&http.Client{Timeout: ${timeout} * time.Millisecond}` : "http.DefaultClient"} }`,
    `\tresp, err := httpClient.Do(req)`, `\tif err != nil { ${ret} }`, `\tdefer resp.Body.Close()`,
    `\tpayload, err := io.ReadAll(io.LimitReader(resp.Body, ${size} + 1))`, `\tif err != nil { ${ret} }`,
    `\tif len(payload) > ${size} { err = fmt.Errorf("response body exceeds %d bytes", ${size}); ${ret} }`,
    `\tif resp.StatusCode != successStatus { err = &HTTPError{StatusCode: resp.StatusCode, Body: payload}; ${ret} }`,
    `\tif ${generic ? "decodeBody" : "target != nil"} { err = models.DecodeJSON(payload, ${generic ? "&result" : "target"}, ${wire.ignoreUnknown}, ${wire.validate}, ${wire.defaults}, ${generic ? "shape..." : "shape"}) }`,
    `\t${ret}`, `}`,
  );
  return { body: out.join("\n"), imports: ["fmt", "net/http", "io", ir.module, ...(timeout ? ["time"] : [])] };
}

export const goNethttpClientTarget: Target<GoIR> = {
  name: "@abhigyakrishna/tspgen-go-nethttp-client", kind: "client", language: "go",
  optionsSchema: goClientOptionsSchema, features: goClientFeatures,
  files: (ir, ctx): FileSpec[] => {
    const options = ctx.options as unknown as GoClientOptions;
    const ops = goOperations(ctx.program, ir);
    const packageName = options.package ?? "client";
    const version = checkHTTPConfiguration(ir, ctx, options, packageName, "1.22");
    if (ctx.features.values["generic-methods"] && !atLeastGo(version, "1.27")) throw new Error("features.generic-methods requires Go 1.27 or newer; set go-version to at least 1.27.");
    if ((options["client-name"] ?? "Client") === "HTTPError") throw new Error("client-name conflicts with HTTPError.");
    const base = runtime(ir, ctx, options);
    const name = options["client-name"] ?? "Client";
    const reserved = new Set([name, "HTTPError", ...(ctx.features.values["client-constructor"] ? [`New${name}`] : [])]);
    const reserve = (identifier: string) => {
      if (reserved.has(identifier)) throw new Error(`Generated Go client identifier ${identifier} conflicts with another declaration.`);
      reserved.add(identifier);
    };
    for (const op of ops) {
      if (["BaseURL", "HTTPClient", ...(ctx.features.values["generic-methods"] ? ["Do"] : [])].includes(op.name)) throw new Error(`Operation ${op.name} conflicts with the client runtime.`);
      reserve(requestName(op, options));
    }
    const operationBody = (operations: GoOperation[]): { body: string; imports: string[] } => {
      const errors = new Map(operations.map((op) => [op.id, options.errors === "typed" ? typedErrors(op, ir, ctx) : []]));
      const allErrors = [...errors.values()].flat();
      for (const error of allErrors) reserve(error.name);
      const types = operations.map((op) => requestDeclaration(op, ir, options));
      const methods = operations.map((op) => method(op, ir, ctx, options, errors.get(op.id)!));
      return { body: [...types, ...allErrors.map((e) => typedErrorDeclaration(e, ir, true)), ...methods].join("\n\n"), imports: [
        ...(operations.length ? ["context", "io", "net/url", "strings", "net/http", ir.module] : []),
        ...(operations.some((op) => op.body) ? ["bytes"] : []),
        ...(allErrors.length ? ["fmt", "errors"] : []), ...operationImports(operations, ir),
        ...allErrors.flatMap((e) => e.body ? typeUse(e.body, ir).imports ?? [] : []),
      ] };
    };
    const files: FileSpec[] = [];
    if (ctx.features.values["go-mod"]) files.push({ path: "client/go.mod", template: "go/dependent-mod", data: { module: options.module, goVersion: version, modelsModule: ir.module, modelsVersion: localModuleVersion(ir.module), modelsDir: modelsDirectory(ctx, "client") } });
    if (!options.grouping || options.grouping === "single-file") {
      const all = operationBody(ops);
      files.push(goFile("client/client.go", [base.body, all.body].join("\n\n"), [...base.imports, ...all.imports], ir, packageName));
    } else {
      files.push(goFile("client/client.go", base.body, base.imports, ir, packageName));
      for (const unit of operationUnits(ops, ir, options.grouping)) {
        const part = operationBody(unit.operations);
        files.push(goFile(`client/${unit.file}_operations.go`, part.body, part.imports, ir, packageName));
      }
    }
    if (ctx.program.hasError()) throw new Error("Cannot generate Go client; see the reported diagnostics.");
    return files;
  },
};

export default goNethttpClientTarget;
