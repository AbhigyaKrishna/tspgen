import {
  constantCase, declarationScopes, resolveMeta,
  type ApiIR, type ModelIR, type PropertyIR, type TypeIR, type TypeRef,
} from "@abhigyakrishna/tspgen-core";
import { NoTarget, type Program } from "@typespec/compiler";
import { reportDiagnostic } from "../lib.js";
import { goName, validJSONTagName, validModule, validPackage } from "../naming.js";
import { resolveGoOptions, type GoOptions } from "../options.js";
import { MINIMUM_GO_VERSION, supportedGoVersion } from "../version.js";
import type { GoDecl, GoEnum, GoField, GoIR, GoStruct, GoUnionTag } from "./model.js";
import { goType, goTypeName, isEnumUnion, pointer, typeIndex } from "./type-map.js";
import { unsupported } from "./diagnostics.js";
import { discriminatorTags, isDiscriminated, unionDeclaration } from "./unions.js";

const MODEL_RUNTIME_NAMES = [
  "ValidationError", "PropertyConstraints", "DecodeJSON", "EncodeJSON", "DecodeParameter",
  "EncodeParameter", "ValidateValue", "ApplyDefaults", "CheckProperty",
];

type ReserveName = (name: string, owner: string) => void;
type EnumSource = Extract<TypeIR, { kind: "enum" | "union" }>;

function declarationNames(program: Program): ReserveName {
  const owners = new Map(MODEL_RUNTIME_NAMES.map((name) => [name, "generated models runtime"]));
  return (name, owner) => {
    const first = owners.get(name);
    if (first) {
      reportDiagnostic(program, { code: "duplicate-name", format: { name, first, second: owner }, target: NoTarget });
      return;
    }
    owners.set(name, owner);
  };
}

function modelAncestors(model: ModelIR, types: Map<string, TypeIR>): ModelIR[] {
  const ancestors: ModelIR[] = [];
  const visited = new Set<string>();
  let current: ModelIR | undefined = model;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    ancestors.unshift(current);
    const base: TypeIR | undefined = current.baseId ? types.get(current.baseId) : undefined;
    current = base?.kind === "model" ? base : undefined;
  }
  return ancestors;
}

/** The `AdditionalProperties` map for the nearest model in the chain that has additional properties. */
function additionalField(model: ModelIR, api: ApiIR, program: Program, options: GoOptions): GoStruct["additional"] {
  const source = modelAncestors(model, typeIndex(api)).reverse().find((item) => item.additionalProperties);
  if (!source?.additionalProperties) return undefined;
  const ref: TypeRef = { kind: "map", of: source.additionalProperties };
  return { type: goType(ref, api, "", program, `${model.id} additional properties`, options), ref };
}

function modelField(property: PropertyIR, api: ApiIR, program: Program, owner: string, options: GoOptions): GoField {
  const id = `${owner}.${property.name}`;
  if (!validJSONTagName(property.wireName)) {
    unsupported(program, id, `encoding/json cannot use ${JSON.stringify(property.wireName)} as a struct tag name`);
  }
  const resolvedType = goType(property.type, api, "", program, id, options);
  const preservesAbsence = property.optional && options.optionalFields === "pointers";
  return {
    name: goName(property.name, options.naming),
    type: preservesAbsence ? pointer(resolvedType) : resolvedType,
    wireName: property.wireName,
    optional: property.optional,
    ref: property.type,
    ...(property.constraints ? { constraints: property.constraints } : {}),
    ...(property.default !== undefined ? { default: property.default } : {}),
    ...(property.docs ? { docs: property.docs } : {}),
  };
}

function modelFields(
  model: ModelIR, api: ApiIR, program: Program, options: GoOptions, validation: boolean, tags: GoUnionTag[],
  additional: boolean,
): GoField[] {
  const properties = new Map<string, PropertyIR>();
  for (const ancestor of modelAncestors(model, typeIndex(api))) {
    for (const property of ancestor.properties) properties.set(property.name, property);
  }
  // Discriminators are written by the tagged codec, not stored.
  const fields = [...properties.values()]
    .filter((property) => !tags.some((tag) => tag.name === property.name || tag.property === property.wireName))
    .map((property) => modelField(property, api, program, model.id, options));
  const owners = new Map<string, string>();
  if (validation) owners.set("Validate", `${model.id} validation method`);
  if (tags.length || additional) for (const method of ["MarshalJSON", "UnmarshalJSON"]) owners.set(method, `${model.id} JSON codec`);
  if (additional) owners.set("AdditionalProperties", `${model.id} additional properties`);
  for (const field of fields) {
    const first = owners.get(field.name);
    const owner = `${model.id}.${field.wireName}`;
    if (first) {
      reportDiagnostic(program, { code: "duplicate-name", format: { name: field.name, first, second: owner }, target: NoTarget });
    } else {
      owners.set(field.name, owner);
    }
  }
  return fields;
}

function modelDeclaration(
  model: ModelIR, api: ApiIR, program: Program, options: GoOptions, reserve: ReserveName, tags: GoUnionTag[],
): GoStruct {
  const name = goTypeName(model, options);
  const meta = resolveMeta(declarationScopes(model.decorators, model.namespaceDecorators), "go");
  const validation = options.features?.at("validation", meta, "model") ?? options.validation;
  const validator = options.features?.at("validator", meta, "model") ?? options.validator;
  const defaults = options.features?.at("defaults", meta, "model") ?? options.defaults;
  const additional = additionalField(model, api, program, options);
  const fields = modelFields(model, api, program, options, validation, tags, additional !== undefined);
  if (defaults) reserve(`New${name}`, `${model.id} constructor`);
  return {
    kind: "struct", id: model.id, name, namespace: model.namespace.join("."), fields, tags,
    ...(additional ? { additional } : {}),
    typeParameters: model.typeParameters?.map((parameter) => goName(parameter, options.naming)) ?? [],
    validation, validator, defaults,
    ...(model.docs ? { docs: model.docs } : {}),
  };
}

function enumMembers(source: EnumSource, options: GoOptions): GoEnum["members"] {
  if (source.kind === "enum") {
    return source.members.map((member) => ({ name: goName(member.name, options.naming), value: member.value }));
  }
  return source.variants.filter((variant) => variant.type.kind === "literal").map((variant, index) => ({
    name: goName(variant.name ?? String(index), options.naming),
    value: (variant.type as Extract<TypeRef, { kind: "literal" }>).value as string | number,
  }));
}

function enumBase(members: GoEnum["members"]): GoEnum["base"] {
  if (typeof members[0]?.value === "string") return "string";
  return members.every((member) => Number.isInteger(member.value)) ? "int64" : "float64";
}

function enumDeclaration(source: EnumSource, program: Program, options: GoOptions, reserve: ReserveName): GoEnum {
  const name = goTypeName(source, options);
  const members = enumMembers(source, options);
  for (const member of members) {
    if (options.naming["enum-members"] === "UPPER_SNAKE") member.name = constantCase(member.name);
    reserve(`${name}${member.name}`, `${source.id}.${member.name}`);
  }
  if (!members.length) unsupported(program, source.id, "empty enums are not supported");
  if (members.some((member) => typeof member.value !== typeof members[0]?.value)) {
    unsupported(program, source.id, "mixed enum value types are not supported");
  }
  const base = enumBase(members);
  const meta = resolveMeta(declarationScopes(source.decorators, source.namespaceDecorators), "go");
  const open = source.kind === "union" && source.variants.some((variant) => variant.type.kind === "scalar");
  const unknown = !open && base === "string" && (options.features?.at("enum-unknown", meta, source.kind) ?? options.enumUnknown);
  if (unknown) reserve(`${name}UNKNOWN`, `${source.id} unknown sentinel`);
  return {
    kind: "enum", id: source.id, name, namespace: source.namespace.join("."), base, members, open, unknown,
    ...(source.docs ? { docs: source.docs } : {}),
  };
}

function scalarAliases(api: ApiIR, program: Program, options: GoOptions, reserve: ReserveName): GoDecl[] {
  if (options.scalarStyle !== "alias") return [];
  return api.customScalars.map((scalar) => {
    const name = goTypeName(scalar, options);
    reserve(name, scalar.id);
    const ref: TypeRef = { kind: "scalar", name: scalar.root, ...(scalar.encoding ? { encoding: scalar.encoding } : {}) };
    const type = goType(ref, api, "", program, scalar.id, options);
    return {
      kind: "alias", id: scalar.id, name, namespace: scalar.namespace.join("."), type,
      ...(scalar.docs ? { docs: scalar.docs } : {}),
    };
  });
}

function validateModelsConfiguration(program: Program, packageName: string, module: string, options: GoOptions): void {
  if (!validPackage(packageName)) {
    reportDiagnostic(program, { code: "invalid-package", format: { name: packageName }, target: NoTarget });
  }
  if (!validModule(module)) {
    reportDiagnostic(program, { code: "invalid-module", format: { name: module }, target: NoTarget });
  }
  if (!supportedGoVersion(options.goVersion, MINIMUM_GO_VERSION)) {
    unsupported(program, "go-version", `Go ${MINIMUM_GO_VERSION} or newer is required`);
  }
}

export function transformToGo(
  program: Program,
  api: ApiIR,
  packageName: string,
  module: string,
  options: GoOptions = resolveGoOptions({}),
): GoIR {
  validateModelsConfiguration(program, packageName, module, options);
  const reserve = declarationNames(program);
  const declarations: GoDecl[] = [];
  const tags = discriminatorTags(api, program);
  for (const source of api.types) {
    // @events unions only type SSE streams, which Go targets reject as operations.
    if (source.kind === "union" && source.events) continue;
    // A std `Record<T>` base only contributes its map: derived structs flatten it into `AdditionalProperties`.
    if (source.kind === "model" && source.namespace.join(".") === "TypeSpec" && source.id.startsWith("Record<")) continue;
    reserve(goTypeName(source, options), source.id);
    if (source.kind === "model" && isDiscriminated(source)) {
      declarations.push(unionDeclaration(source, api, program, options, reserve));
    } else if (source.kind === "model") {
      declarations.push(modelDeclaration(source, api, program, options, reserve, tags.get(source.id) ?? []));
    } else if (source.kind === "enum" || isEnumUnion(source)) {
      declarations.push(enumDeclaration(source, program, options, reserve));
    } else {
      declarations.push(unionDeclaration(source, api, program, options, reserve));
    }
  }
  declarations.push(...scalarAliases(api, program, options, reserve));
  return { api, packageName, module, declarations, options };
}
