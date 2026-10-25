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
        ...(decl.properties.some((p) => p.encodeDefault || p.presence)
          ? ["kotlinx.serialization.EncodeDefault", "kotlinx.serialization.ExperimentalSerializationApi"]
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
      return decl.unknown
        ? [
            "kotlinx.serialization.KSerializer",
            "kotlinx.serialization.Serializable",
            "kotlinx.serialization.SerializationException",
            "kotlinx.serialization.descriptors.PrimitiveKind",
            "kotlinx.serialization.descriptors.PrimitiveSerialDescriptor",
            "kotlinx.serialization.descriptors.SerialDescriptor",
            "kotlinx.serialization.encoding.Decoder",
            "kotlinx.serialization.encoding.Encoder",
          ]
        : [
            ...(decl.members.some(needsSerialName) ? ["kotlinx.serialization.SerialName"] : []),
            "kotlinx.serialization.Serializable",
          ];
    case "value-class":
      return ["kotlinx.serialization.Serializable"];
    case "untagged-union":
      return ["kotlinx.serialization.Serializable", "kotlinx.serialization.KSerializer", "kotlinx.serialization.SerializationException",
        "kotlinx.serialization.descriptors.buildClassSerialDescriptor", "kotlinx.serialization.encoding.Decoder", "kotlinx.serialization.encoding.Encoder",
        "kotlinx.serialization.json.JsonDecoder", "kotlinx.serialization.json.JsonEncoder", "kotlinx.serialization.json.Json",
        "kotlinx.serialization.json.decodeFromJsonElement", "kotlinx.serialization.json.encodeToJsonElement",
        "kotlinx.serialization.json.JsonObject", "kotlinx.serialization.json.JsonArray", "kotlinx.serialization.json.JsonPrimitive",
        "kotlinx.serialization.json.JsonNull", "kotlinx.serialization.json.booleanOrNull", "kotlinx.serialization.json.doubleOrNull"];
    case "typealias":
    case "events":
      return [];
  }
}
