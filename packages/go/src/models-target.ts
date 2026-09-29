import { apiVersionConstants, type ConstraintsIR, type FileSpec, type Target, type TypeRef } from "@abhigyakrishna/tspgen-core";
import { fileName, goOperations, type GoDecl, type GoField, type GoIR } from "./transform.js";

export function nullShape(ref: TypeRef): string {
  if (ref.kind === "nullable") return `?${nullShape(ref.of)}`;
  if (ref.kind === "array") return `a${nullShape(ref.of)}`;
  if (ref.kind === "map") return `m${nullShape(ref.of)}`;
  return ref.kind === "unknown" || ref.kind === "typeParam" ? "?_" : "_";
}

export function constraintsLiteral(constraints?: ConstraintsIR, ref?: TypeRef): string {
  const c = constraints ?? {};
  return `models.PropertyConstraints{MinLength: ${c.minLength ?? -1}, MaxLength: ${c.maxLength ?? -1}, MinItems: ${c.minItems ?? -1}, MaxItems: ${c.maxItems ?? -1}, MinValue: ${JSON.stringify(c.minValue === undefined ? "" : String(c.minValue))}, MaxValue: ${JSON.stringify(c.maxValue === undefined ? "" : String(c.maxValue))}, Pattern: ${JSON.stringify(c.pattern ?? "")}, Literal: ${JSON.stringify(ref?.kind === "literal" ? JSON.stringify(ref.value) : "")}}`;
}

function defaultJSON(field: GoField, ir: GoIR): string {
  const ref = field.ref.kind === "nullable" ? field.ref.of : field.ref;
  const value = ref.kind === "scalar" && ["decimal", "decimal128"].includes(ref.name) && ir.options.decimal === "string" && field.default !== null
    ? String(field.default) : field.default;
  return JSON.stringify(value);
}

function fieldTag(field: GoField, decl: Extract<GoDecl, { kind: "struct" }>, ir: GoIR): string {
  const pairs = [
    `json:${JSON.stringify(`${field.wireName}${field.optional && ir.options.omitEmpty ? ",omitempty" : ""}`)}`,
    `tsp:${JSON.stringify(`${field.optional ? "optional" : "required"},${nullShape(field.ref)}`)}`,
    ...(!decl.validation ? ['tspvalidate:"false"'] : []),
    ...(decl.defaults && field.default !== undefined ? [`default:${JSON.stringify(defaultJSON(field, ir))}`] : []),
  ];
  const tag = pairs.join(" ");
  return tag.includes("`") ? JSON.stringify(tag) : `\`${tag}\``;
}

function declarationBody(decl: GoDecl, ir: GoIR): { body: string; imports: string[] } {
  const docs = decl.docs?.split("\n").map((line) => `// ${line}`) ?? [];
  if (decl.kind === "alias") return { body: [...docs, `type ${decl.name} = ${decl.type.text}`].join("\n"), imports: decl.type.imports ?? [] };
  if (decl.kind === "struct") {
    const parameters = decl.typeParameters.length ? `[${decl.typeParameters.map((p) => `${p} any`).join(", ")}]` : "";
    const instance = `${decl.name}${decl.typeParameters.length ? `[${decl.typeParameters.join(", ")}]` : ""}`;
    const out = [...docs, `type ${decl.name}${parameters} struct {`];
    for (const field of decl.fields) {
      out.push(...(field.docs?.split("\n").map((line) => `\t// ${line}`) ?? []), `\t${field.name} ${field.type.text} ${fieldTag(field, decl, ir)}`);
    }
    out.push("}");
    if (decl.defaults) out.push("", `// New${decl.name} initializes declared property defaults.`, `func New${decl.name}${parameters}() *${instance} {`, `\tvalue := new(${instance})`, `\tif err := ApplyDefaults(value); err != nil { panic(err) }`, "\treturn value", "}");
    if (decl.validation) {
      out.push("", `func (value *${instance}) Validate() error {`, `\tif value == nil { return &ValidationError{Field: ${JSON.stringify(decl.name)}, Message: "must not be null"} }`);
      for (const field of decl.fields) out.push(`\tif err := CheckProperty(${JSON.stringify(field.wireName)}, value.${field.name}, ${field.optional}, ${JSON.stringify(nullShape(field.ref))}, ${constraintsLiteral(field.constraints, field.ref).replace("models.PropertyConstraints", "PropertyConstraints")}); err != nil { return err }`);
      out.push("\treturn nil", "}");
    }
    return { body: out.join("\n"), imports: decl.fields.flatMap((f) => f.type.imports ?? []) };
  }
  const out = [...docs, `type ${decl.name} ${decl.base}`, "", "const (", ...decl.members.map((m) => `\t${decl.name}${m.name} ${decl.name} = ${JSON.stringify(m.value)}`)];
  if (decl.unknown) out.push(`\t${decl.name}UNKNOWN ${decl.name} = "\\x00tspgen.UNKNOWN"`);
  out.push(")");
  if (ir.options.validation) out.push("", `func (value ${decl.name}) Validate() error {`, "\tswitch value {", `\tcase ${[...decl.members.map((m) => `${decl.name}${m.name}`), ...(decl.unknown ? [`${decl.name}UNKNOWN`] : [])].join(", ")}:`, "\t\treturn nil", "\t}", `\treturn &ValidationError{Field: ${JSON.stringify(decl.name)}, Message: "unknown enum value"}`, "}");
  if (decl.unknown) out.push("", `func (value *${decl.name}) UnmarshalJSON(data []byte) error {`, "\tvar wire string", "\tif err := json.Unmarshal(data, &wire); err != nil { return err }", `\tswitch ${decl.name}(wire) {`, `\tcase ${decl.members.map((m) => `${decl.name}${m.name}`).join(", ")}:`, `\t\t*value = ${decl.name}(wire)`, "\tdefault:", `\t\t*value = ${decl.name}UNKNOWN`, "\t}", "\treturn nil", "}", "", `func (value ${decl.name}) MarshalJSON() ([]byte, error) {`, `\tif value == ${decl.name}UNKNOWN { return nil, &ValidationError{Field: ${JSON.stringify(decl.name)}, Message: "UNKNOWN cannot be encoded"} }`, "\treturn json.Marshal(string(value))", "}");
  return { body: out.join("\n"), imports: decl.unknown ? ["encoding/json"] : [] };
}

function modelFile(ir: GoIR, path: string, declarations: GoDecl[], constants: string[] = []): FileSpec {
  const parts = declarations.map((d) => declarationBody(d, ir));
  const imports = [...new Set(parts.flatMap((d) => d.imports))].sort();
  const body = [...(imports.length ? [`import (\n${imports.map((name) => `\t${JSON.stringify(name)}`).join("\n")}\n)`] : []), ...parts.map((d) => d.body), ...constants].join("\n\n");
  return { path, template: "go/file", data: { package: ir.packageName, body } };
}

export const goModelsTarget: Target<GoIR> = {
  name: "go-models", kind: "models", language: "go",
  files: (ir, ctx): FileSpec[] => {
    if (ctx.program.hasError()) { goOperations(ctx.program, ir); throw new Error("Cannot generate Go models; see the reported diagnostics."); }
    const files: FileSpec[] = [];
    if (ctx.features.values["go-mod"] !== false) files.push({ path: "models/go.mod", template: "go/mod", data: { module: ir.module, goVersion: ir.options.goVersion } });
    files.push({ path: "models/runtime.go", template: "go/runtime", data: { package: ir.packageName } });
    const versions = ctx.features.values["api-version"] !== false ? apiVersionConstants(ir.api).map((v) => `const ${v.name} = ${JSON.stringify(v.value)}`) : [];
    if (ir.options.layout === "single-file") files.push(modelFile(ir, "models/models.go", ir.declarations, versions));
    else {
      const groups = new Map<string, GoDecl[]>();
      for (const decl of ir.declarations) {
        const name = ir.options.layout === "per-type" ? fileName(decl.name) : fileName(decl.namespace || "global");
        const path = `models/${name === "runtime" || name === "api_version" ? `${name}_types` : name}.go`;
        groups.set(path, [...(groups.get(path) ?? []), decl]);
      }
      for (const [path, declarations] of groups) files.push(modelFile(ir, path, declarations));
      if (versions.length) files.push(modelFile(ir, "models/api_version.go", [], versions));
    }
    return files;
  },
};
