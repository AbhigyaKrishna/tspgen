import { apiVersionConstants, type FileSpec, type Target } from "@abhigyakrishna/tspgen-core";
import type { GoDecl, GoIR } from "./transform.js";

function lines(decl: GoDecl): string[] {
  const docs = decl.docs?.split("\n").map((line) => `// ${line}`) ?? [];
  if (decl.kind === "struct") {
    const params = decl.typeParameters.length ? `[${decl.typeParameters.map((p) => `${p} any`).join(", ")}]` : "";
    return [
      ...docs,
      `type ${decl.name}${params} struct {`,
      ...decl.fields.map((f) => {
        const tag = `json:${JSON.stringify(`${f.wireName}${f.optional ? ",omitempty" : ""}`)}`;
        const literal = tag.includes("`") ? JSON.stringify(tag) : `\`${tag}\``;
        return `\t${f.name} ${f.type.text} ${literal}`;
      }),
      "}",
    ];
  }
  return [
    ...docs,
    `type ${decl.name} ${decl.base}`,
    "",
    "const (",
    ...decl.members.map((m) => `\t${decl.name}${m.name} ${decl.name} = ${JSON.stringify(m.value)}`),
    ")",
  ];
}

function modelBody(ir: GoIR, apiVersion: boolean): string {
  const versions = apiVersion ? apiVersionConstants(ir.api).map((v) => `const ${v.name} = ${JSON.stringify(v.value)}`) : [];
  const declarations = [...ir.declarations.map((d) => lines(d).join("\n")), ...versions].join("\n\n");
  return declarations.includes("json.Number") ? `import "encoding/json"\n\n${declarations}` : declarations;
}

export const goModelsTarget: Target<GoIR> = {
  name: "go-models",
  kind: "models",
  language: "go",
  files: (ir, ctx): FileSpec[] => [
    { path: "models/go.mod", template: "go/mod", data: { module: ir.module } },
    { path: "models/models.go", template: "go/file", data: { package: ir.packageName, body: modelBody(ir, ctx.features.values["api-version"] !== false) } },
  ],
};
