import type { GoDecl, GoField, GoIR } from "../transform.js";
import type { GoSourceSection } from "../source.js";
import { nullShape, propertyCheck, propertyCheckCall } from "../validation.js";
import { additionalValidatorTag, validatorTag } from "./validator.js";

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
  const validationTag = decl.validator ? validatorTag(field, ir) : "";
  if (validationTag) pairs.push(`validate:${JSON.stringify(validationTag)}`);
  if (decl.defaults && field.default !== undefined) pairs.push(`default:${JSON.stringify(defaultJSON(field, ir))}`);
  return structTag(pairs);
}

function structTag(pairs: string[]): string {
  const tag = pairs.join(" ");
  return tag.includes("`") ? JSON.stringify(tag) : `\`${tag}\``;
}

function additionalTag(decl: Extract<GoDecl, { kind: "struct" }>, ir: GoIR): string {
  const ref = decl.additional!.ref;
  const pairs = ['json:"-"', `tsp:${JSON.stringify(`additional,${nullShape(ref, ir.api)}`)}`];
  if (!decl.validation) pairs.push('tspvalidate:"false"');
  if (decl.validator) pairs.push(`validate:${JSON.stringify(additionalValidatorTag(ref, ir))}`);
  return structTag(pairs);
}

const goString = (value: string) => JSON.stringify(value);
const goStrings = (values: string[]) => `[]string{${values.map(goString).join(", ")}}`;

function unionInfoFields(decl: Extract<GoDecl, { kind: "union" }>): string {
  const variants = decl.variants.map((variant) => `{Field: ${goString(variant.name)}, Values: ${goStrings(variant.values)}, `
    + `Kind: ${goString(variant.kind)}, Literal: ${goString(variant.literal ?? "")}, Shape: ${goString(variant.shape)}, `
    + `Text: ${variant.text}, Members: ${goStrings(variant.members)}}`);
  const discriminator = decl.discriminator;
  return [
    `Name: ${goString(decl.name)}`,
    ...(discriminator ? [
      `Property: ${goString(discriminator.property)}`,
      `Envelope: ${goString(discriminator.envelope)}`,
      ...(discriminator.envelope === "object" ? [`EnvelopeProperty: ${goString(discriminator.envelopeProperty)}`] : []),
    ] : []),
    `Variants: []unionVariant{${variants.join(", ")}}`,
    `Unknown: ${decl.unknown}`,
  ].join(", ");
}

export function modelDeclaration(decl: GoDecl, ir: GoIR): GoSourceSection {
  const docs = decl.docs?.split("\n") ?? [];
  switch (decl.kind) {
    case "alias":
      return { template: "go/model/alias", data: { ...decl, docs } };
    case "enum": {
      const members = decl.members.map((member) => ({ ...member, name: `${decl.name}${member.name}` }));
      const unique = [...new Map(members.map((member) => [member.value, member.name])).entries()];
      const cases = unique.map(([, name]) => name);
      // Parameters use the canonical member text, matching union `Members`.
      const texts = unique.map(([value, name]) => ({ name, text: goString(String(value)) }));
      const validNames = [...cases];
      if (decl.unknown) validNames.push(`${decl.name}UNKNOWN`);
      return {
        template: "go/model/enum",
        data: { ...decl, docs, members, cases, texts, validNames, validation: ir.options.validation && !decl.open },
      };
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
      const tags = decl.tags.map((tag) => `{Property: ${goString(tag.property)}, Values: ${goStrings(tag.values)}}`).join(", ");
      const additional = decl.additional ? {
        text: decl.additional.type.text,
        tag: additionalTag(decl, ir),
        check: propertyCheckCall(propertyCheck(
          "additionalProperties", "value.AdditionalProperties", true, decl.additional.ref, undefined, "", ir.api,
        ), ""),
      } : undefined;
      const tagsRef = decl.tags.length ? `unionTags${decl.name}` : "nil";
      return { template: "go/model/struct", data: { ...decl, docs, typeParameters, instance, fields, tagsLiteral: tags, additional, tagsRef } };
    }
    case "union": {
      const variants = decl.variants.map((variant) => ({ ...variant, docs: variant.docs?.split("\n") ?? [] }));
      return { template: "go/model/union", data: { ...decl, docs, variants, info: unionInfoFields(decl) } };
    }
  }
}

export function modelImports(decl: GoDecl): string[] {
  switch (decl.kind) {
    case "alias": return decl.type.imports ?? [];
    case "struct": return [...decl.fields.flatMap((field) => field.type.imports ?? []), ...(decl.additional?.type.imports ?? [])];
    case "enum": return decl.unknown ? ["encoding/json"] : [];
    case "union": return [
      ...decl.variants.flatMap((variant) => variant.type.imports ?? []),
      ...(decl.unknown ? ["encoding/json"] : []),
    ];
  }
}
