import type { FileSpec, Target, TargetContext } from "@abhigyakrishna/tspgen-core";
import { goName, goOperations, goType, localModuleVersion, validModule, validPackage, reportDiagnostic, type GoIR, type GoOperation, type GoType } from "@abhigyakrishna/tspgen-go";
import { NoTarget } from "@typespec/compiler";
import { relative, resolve, sep } from "node:path";

interface Options { module: string; package?: string }

const optionsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    module: { type: "string", description: "Import path of the generated Go client module." },
    package: { type: "string", default: "client", description: "Go package name of generated client files." },
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

function method(op: GoOperation, ir: GoIR): string {
  const response = op.success.body ? goType(op.success.body.type, ir.api, "models.").text : undefined;
  const ret = response ? "return result, err" : "return err";
  const signature = response ? `(result ${response}, err error)` : `(err error)`;
  const out = [
    `func (c *Client) ${op.name}(ctx context.Context, request ${op.name}Request) ${signature} {`,
    `\tpath := ${JSON.stringify(op.path)}`,
  ];
  for (const p of op.params.filter((p) => p.location === "path")) {
    const field = `request.${goName(`${p.location} ${p.name}`)}`;
    out.push(`\tpath = strings.ReplaceAll(path, ${JSON.stringify(`{${p.wireName}}`)}, url.PathEscape(fmt.Sprint(${field})))`);
  }
  out.push(
    `\tu, err := url.Parse(strings.TrimRight(c.BaseURL, "/") + path)`,
    `\tif err != nil { ${ret} }`,
    `\tquery := u.Query()`,
  );
  for (const p of op.params.filter((p) => p.location === "query")) {
    const field = `request.${goName(`${p.location} ${p.name}`)}`;
    if (p.optional) out.push(`\tif ${field} != nil { query.Set(${JSON.stringify(p.wireName)}, fmt.Sprint(*${field})) }`);
    else out.push(`\tquery.Set(${JSON.stringify(p.wireName)}, fmt.Sprint(${field}))`);
  }
  out.push(`\tu.RawQuery = query.Encode()`, `\tvar body io.Reader`);
  if (op.body) {
    if (op.body.optional) out.push(`\tif request.Body != nil {`);
    out.push(`\tpayload, marshalErr := json.Marshal(request.Body)`, `\tif marshalErr != nil { err = marshalErr; ${ret} }`, `\tbody = bytes.NewReader(payload)`);
    if (op.body.optional) out.push(`\t}`);
  }
  out.push(
    `\treq, err := http.NewRequestWithContext(ctx, ${JSON.stringify(op.verb)}, u.String(), body)`,
    `\tif err != nil { ${ret} }`,
  );
  if (op.body) out.push(`\tif body != nil { req.Header.Set("Content-Type", "application/json") }`);
  for (const p of op.params.filter((p) => p.location === "header")) {
    const field = `request.${goName(`${p.location} ${p.name}`)}`;
    if (p.optional) out.push(`\tif ${field} != nil { req.Header.Set(${JSON.stringify(p.wireName)}, fmt.Sprint(*${field})) }`);
    else out.push(`\treq.Header.Set(${JSON.stringify(p.wireName)}, fmt.Sprint(${field}))`);
  }
  out.push(
    `\thttpClient := c.HTTPClient`,
    `\tif httpClient == nil { httpClient = http.DefaultClient }`,
    `\tresp, err := httpClient.Do(req)`,
    `\tif err != nil { ${ret} }`,
    `\tdefer resp.Body.Close()`,
    `\tif resp.StatusCode != ${op.status} {`,
    `\t\traw, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))`,
    `\t\tif readErr != nil { err = readErr; ${ret} }`,
    `\t\terr = &HTTPError{StatusCode: resp.StatusCode, Body: raw}`,
    `\t\t${ret}`,
    `\t}`,
  );
  if (response) out.push(`\terr = json.NewDecoder(resp.Body).Decode(&result)`);
  out.push(`\t${ret}`, `}`);
  return out.join("\n");
}

function clientBody(ir: GoIR, ctx: TargetContext): string {
  const operations = goOperations(ctx.program, ir);
  const requests = operations.map((op) => [`type ${op.name}Request struct {`, ...requestFields(op, ir), "}"].join("\n"));
  const methods = operations.map((op) => method(op, ir));
  const imports = ["fmt", "net/http"];
  if (operations.length) imports.push("context", "io", "net/url", "strings");
  if (operations.some((op) => op.body)) imports.push("bytes");
  if (operations.some((op) => op.body || op.success.body) || requests.some((s) => s.includes("json.Number"))) imports.push("encoding/json");
  if ([...requests, ...methods].some((s) => s.includes("models."))) imports.push(ir.module);
  imports.sort();
  const rendered = imports.map((name) => name === ir.module ? `\tmodels ${JSON.stringify(name)}` : `\t${JSON.stringify(name)}`);
  return [
    `import (`, ...rendered, `)`,
    ``,
    `type Client struct {`, `\tBaseURL string`, `\tHTTPClient *http.Client`, `}`,
    ``,
    `type HTTPError struct {`, `\tStatusCode int`, `\tBody []byte`, `}`,
    ``,
    `func (e *HTTPError) Error() string { return fmt.Sprintf("HTTP %d: %s", e.StatusCode, e.Body) }`,
    ...requests.flatMap((s) => ["", s]),
    ...methods.flatMap((s) => ["", s]),
  ].join("\n");
}

export const goNethttpClientTarget: Target<GoIR> = {
  name: "@abhigyakrishna/tspgen-go-nethttp-client",
  kind: "client",
  language: "go",
  optionsSchema,
  files: (ir, ctx): FileSpec[] => {
    const options = ctx.options as unknown as Options;
    const packageName = options.package ?? "client";
    if (!validModule(options.module)) reportDiagnostic(ctx.program, { code: "invalid-module", format: { name: String(options.module) }, target: NoTarget });
    if (!validPackage(packageName)) reportDiagnostic(ctx.program, { code: "invalid-package", format: { name: packageName }, target: NoTarget });
    const modelsDir = relative(resolve(ctx.outputDir, "client"), resolve(ctx.modelsOutputDir, "models")).split(sep).join("/");
    return [
      { path: "client/go.mod", template: "go/dependent-mod", data: { module: options.module, modelsModule: ir.module, modelsVersion: localModuleVersion(ir.module), modelsDir: modelsDir.startsWith(".") ? modelsDir : `./${modelsDir}` } },
      { path: "client/client.go", template: "go/file", data: { package: packageName, body: clientBody(ir, ctx) } },
    ];
  },
};

export default goNethttpClientTarget;
