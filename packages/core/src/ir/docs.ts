import { getDeprecationDetails, getDoc, type Program, type Type } from "@typespec/compiler";
import type { DocInfo } from "./types.js";

export function docInfo(program: Program, type: Type): DocInfo {
  const info: DocInfo = {};
  const docs = getDoc(program, type);
  if (docs) info.docs = docs;
  const deprecated = getDeprecationDetails(program, type);
  if (deprecated) info.deprecated = deprecated.message;
  return info;
}
