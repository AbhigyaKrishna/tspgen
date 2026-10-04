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

/** A discriminator a variant model writes and checks; `values[0]` is the one written. */
export interface GoUnionTag {
  property: string;
  /** TypeSpec name of a `@discriminator` property, whose overrides may have another JSON name. */
  name?: string;
  values: string[];
}

export interface GoStruct extends GoDeclaration {
  kind: "struct";
  fields: GoField[];
  tags: GoUnionTag[];
  typeParameters: string[];
  validation: boolean;
  validator: boolean;
  defaults: boolean;
}

export interface GoEnum extends GoDeclaration {
  kind: "enum";
  base: "string" | "int64" | "float64";
  members: { name: string; value: string | number }[];
  /** A union widened by `string`: any string is valid; the constants name the known values. */
  open: boolean;
  unknown: boolean;
}

export interface GoAlias extends GoDeclaration {
  kind: "alias";
  type: GoType;
}

export interface GoUnionVariant {
  name: string;
  type: GoType;
  values: string[];
  /** First JSON byte class for untagged dispatch: `{ [ " 0 t`, or `*` for any. */
  kind: string;
  literal?: string;
  shape: string;
  docs?: string;
}

export interface GoUnion extends GoDeclaration {
  kind: "union";
  variants: GoUnionVariant[];
  discriminator?: { property: string; envelope: "none" | "object"; envelopeProperty: string };
  unknown: boolean;
  validation: boolean;
}

export type GoDecl = GoStruct | GoEnum | GoAlias | GoUnion;

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
