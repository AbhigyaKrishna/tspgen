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
  /** The map holding JSON properties the model does not declare (`...Record<T>`, `extends Record<T>`). */
  additional?: { type: GoType; ref: TypeRef };
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
  /**
   * Parameter text rank by TypeSpec scalar: 0 none (bytes, unknown), 1 exact (`members`), 2 boolean, 3 integer family,
   * 4 float/decimal family, 5 other scalar with a non-string Go type, 6 string-typed (incl. open enums).
   */
  text: number;
  /** Exact texts for rank 1 (literal text or enum member values). */
  members: string[];
  docs?: string;
}

export interface GoUnion extends GoDeclaration {
  kind: "union";
  variants: GoUnionVariant[];
  discriminator?: { property: string; envelope: "none" | "object"; envelopeProperty: string };
  unknown: boolean;
  validation: boolean;
  /** Every variant has a text rank, so the union implements MarshalText/UnmarshalText. */
  text: boolean;
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
