import {
  constantCase, declarationScopes, resolveMeta,
  type ApiIR, type ModelIR, type PropertyIR, type TypeIR, type TypeRef,
} from "@abhigyakrishna/tspgen-core";
import { NoTarget, type Program } from "@typespec/compiler";
import { reportDiagnostic } from "../lib.js";
import { goName, validModule, validPackage } from "../naming.js";
import { atLeastGo, resolveGoOptions, type GoOptions } from "../options.js";
import type { GoDecl, GoEnum, GoField, GoIR, GoStruct } from "./model.js";
import { goType, goTypeName, pointer } from "./type-map.js";
import { unsupported } from "./diagnostics.js";

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

function modelField(property: PropertyIR, api: ApiIR, program: Program, owner: string, options: GoOptions): GoField {
  const id = `${owner}.${property.name}`;
  if (!property.wireName || property.wireName.includes(",")) {
    unsupported(program, id, "JSON field names cannot be represented in a Go struct tag");
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

function modelFields(model: ModelIR, api: ApiIR, program: Program, options: GoOptions, validation: boolean): GoField[] {
  const types = new Map(api.types.map((type) => [type.id, type]));
  const properties = new Map<string, PropertyIR>();
  for (const ancestor of modelAncestors(model, types)) {
    for (const property of ancestor.properties) properties.set(property.name, property);
  }
  const fields = [...properties.values()].map((property) => modelField(property, api, program, model.id, options));
  const owners = new Map<string, string>();
  if (validation) owners.set("Validate", `${model.id} validation method`);
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

function modelDeclaration(model: ModelIR, api: ApiIR, program: Program, options: GoOptions, reserve: ReserveName): GoStruct {
  const name = goTypeName(model, options);
  const meta = resolveMeta(declarationScopes(model.decorators, model.namespaceDecorators), "go");
  const validation = options.features?.at("validation", meta, "model") ?? options.validation;
  const validator = options.features?.at("validator", meta, "model") ?? options.validator;
  const defaults = options.features?.at("defaults", meta, "model") ?? options.defaults;
  if (model.discriminator) unsupported(program, model.id, "discriminated models are not supported yet");
  if (model.additionalProperties) unsupported(program, model.id, "additional properties are not supported yet");
  const fields = modelFields(model, api, program, options, validation);
  if (defaults) reserve(`New${name}`, `${model.id} constructor`);
  return {
    kind: "struct", id: model.id, name, namespace: model.namespace.join("."), fields,
    typeParameters: model.typeParameters?.map((parameter) => goName(parameter, options.naming)) ?? [],
    validation, validator, defaults,
    ...(model.docs ? { docs: model.docs } : {}),
  };
}

function enumMembers(source: EnumSource, options: GoOptions): GoEnum["members"] {
  if (source.kind === "enum") {
    return source.members.map((member) => ({ name: goName(member.name, options.naming), value: member.value }));
  }
  return source.variants.map((variant, index) => ({
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
  const unknown = base === "string" && (options.features?.at("enum-unknown", meta, source.kind) ?? options.enumUnknown);
  if (unknown) reserve(`${name}UNKNOWN`, `${source.id} unknown sentinel`);
  return {
    kind: "enum", id: source.id, name, namespace: source.namespace.join("."), base, members, unknown,
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
  if (!/^1\.[0-9]+(?:\.[0-9]+)?$/.test(options.goVersion) || !atLeastGo(options.goVersion, "1.22")) {
    unsupported(program, "go-version", "Go 1.22 or newer is required");
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
  for (const source of api.types) {
    reserve(goTypeName(source, options), source.id);
    if (source.kind === "model") {
      declarations.push(modelDeclaration(source, api, program, options, reserve));
    } else if (source.kind === "enum" || source.variants.every((variant) =>
      variant.type.kind === "literal" && typeof variant.type.value !== "boolean",
    )) {
      declarations.push(enumDeclaration(source, program, options, reserve));
    } else {
      unsupported(program, source.id, "unions are not supported yet");
    }
  }
  declarations.push(...scalarAliases(api, program, options, reserve));
  return { api, packageName, module, declarations, options };
}
