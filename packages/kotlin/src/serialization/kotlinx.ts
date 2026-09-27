import type { KtDecl, KtEnumMember } from "../transform/model.js";

/** An enum member needs `@SerialName` only when its wire value differs from its Kotlin name. */
export function needsSerialName(member: KtEnumMember): boolean {
  return member.serialName !== member.name.replace(/`/g, "");
}

/** Imports needed by the kotlinx.serialization annotations used in the model templates. */
export function kotlinxImports(decl: KtDecl): string[] {
  switch (decl.kind) {
    case "data-class":
      if (decl.plain) return [];
      return [
        "kotlinx.serialization.Serializable",
        ...(decl.serialName !== undefined || decl.properties.some((p) => p.serialName !== undefined)
          ? ["kotlinx.serialization.SerialName"]
          : []),
      ];
    case "sealed-interface":
      return [
        "kotlinx.serialization.ExperimentalSerializationApi",
        "kotlinx.serialization.Serializable",
        "kotlinx.serialization.json.JsonClassDiscriminator",
        ...decl.variants.flatMap(kotlinxImports),
      ];
    case "enum":
      return [
        ...(decl.members.some(needsSerialName) ? ["kotlinx.serialization.SerialName"] : []),
        "kotlinx.serialization.Serializable",
      ];
    case "typealias":
      return [];
  }
}
