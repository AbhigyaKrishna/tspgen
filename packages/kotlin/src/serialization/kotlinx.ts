import type { KtDecl } from "../transform/model.js";

/** Imports needed by the kotlinx.serialization annotations used in the model templates. */
export function kotlinxImports(decl: KtDecl): string[] {
  switch (decl.kind) {
    case "data-class":
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
      ];
    case "enum":
      return ["kotlinx.serialization.SerialName", "kotlinx.serialization.Serializable"];
    case "typealias":
      return [];
  }
}
