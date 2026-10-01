import type { GoDecl, GoField, GoIR } from "../transform.js";
import type { GoSourceSection } from "../source.js";
import { nullShape, propertyCheck, propertyCheckCall } from "../validation.js";

function defaultJSON(field: GoField, ir: GoIR): string {
  const ref = field.ref.kind === "nullable" ? field.ref.of : field.ref;
  const stringDecimal = ref.kind === "scalar" && ["decimal", "decimal128"].includes(ref.name)
    && ir.options.decimal === "string" && field.default !== null;
  return JSON.stringify(stringDecimal ? String(field.default) : field.default);
}

function fieldTag(field: GoField, decl: Extract<GoDecl, { kind: "struct" }>, ir: GoIR): string {
  const omitEmpty = field.optional && ir.options.omitEmpty ? ",omitempty" : "";
  const jsonName = field.wireName + (omitEmpty || (field.wireName === "-" ? "," : ""));
  const presence = field.optional ? "optional" : "required";
  const pairs = [
    `json:${JSON.stringify(jsonName)}`,
    `tsp:${JSON.stringify(`${presence},${nullShape(field.ref, ir.api)}`)}`,
  ];
  if (field.optional && field.ref.kind === "typeParam" && ir.options.optionalFields === "pointers") {
    pairs.push('tspoptionalpointer:"true"');
  }
  if (!decl.validation) pairs.push('tspvalidate:"false"');
  if (decl.defaults && field.default !== undefined) pairs.push(`default:${JSON.stringify(defaultJSON(field, ir))}`);
  const tag = pairs.join(" ");
  return tag.includes("`") ? JSON.stringify(tag) : `\`${tag}\``;
}

export function modelDeclaration(decl: GoDecl, ir: GoIR): GoSourceSection {
  const docs = decl.docs?.split("\n") ?? [];
  switch (decl.kind) {
    case "alias":
      return { template: "go/model/alias", data: { ...decl, docs } };
    case "enum": {
      const members = decl.members.map((member) => ({ ...member, name: `${decl.name}${member.name}` }));
      const cases = [...new Map(members.map((member) => [member.value, member.name])).values()];
      const validNames = [...cases];
      if (decl.unknown) validNames.push(`${decl.name}UNKNOWN`);
      return { template: "go/model/enum", data: { ...decl, docs, members, cases, validNames, validation: ir.options.validation } };
    }
    case "struct": {
      const parameters = decl.typeParameters;
      const typeParameters = parameters.length ? `[${parameters.map((name) => `${name} any`).join(", ")}]` : "";
      const instance = decl.name + (parameters.length ? `[${parameters.join(", ")}]` : "");
      const fields = decl.fields.map((field) => ({
        ...field,
        docs: field.docs?.split("\n") ?? [],
        tag: fieldTag(field, decl, ir),
        check: propertyCheckCall(propertyCheck(
          field.wireName, `value.${field.name}`, field.optional, field.ref, field.constraints, "", ir.api,
        ), ""),
      }));
      return { template: "go/model/struct", data: { ...decl, docs, typeParameters, instance, fields } };
    }
  }
}

export function modelImports(decl: GoDecl): string[] {
  switch (decl.kind) {
    case "alias": return decl.type.imports ?? [];
    case "struct": return decl.fields.flatMap((field) => field.type.imports ?? []);
    case "enum": return decl.unknown ? ["encoding/json"] : [];
  }
}
