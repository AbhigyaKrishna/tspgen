import type { ApiIR, ConstraintsIR, ParamIR, ResponseIR, TypeRef } from "@abhigyakrishna/tspgen-core";
import type { GoOptions } from "../options.js";

export interface GoType {
  text: string;
  /** A model pointer or nullable type already carries an absence marker. */
  pointer: boolean;
  imports?: string[];
}

export interface GoField {
  name: string;
  type: GoType;
  wireName: string;
  optional: boolean;
  ref: TypeRef;
  constraints?: ConstraintsIR;
  default?: unknown;
  docs?: string;
}

interface GoDeclaration {
  id: string;
  name: string;
  namespace: string;
  docs?: string;
}

export interface GoStruct extends GoDeclaration {
  kind: "struct";
  fields: GoField[];
  typeParameters: string[];
  validation: boolean;
  defaults: boolean;
}

export interface GoEnum extends GoDeclaration {
  kind: "enum";
  base: "string" | "int64" | "float64";
  members: { name: string; value: string | number }[];
  unknown: boolean;
}

export interface GoAlias extends GoDeclaration {
  kind: "alias";
  type: GoType;
}

export type GoDecl = GoStruct | GoEnum | GoAlias;

export interface GoIR {
  api: ApiIR;
  packageName: string;
  module: string;
  declarations: GoDecl[];
  options: GoOptions;
}

export interface GoOperation {
  id: string;
  name: string;
  verb: string;
  path: string;
  params: ParamIR[];
  body?: { type: TypeRef; optional: boolean; constraints?: ConstraintsIR };
  success: ResponseIR;
  status: number;
  group: string;
  namespace: string;
  errors: ResponseIR[];
  docs?: string;
}
