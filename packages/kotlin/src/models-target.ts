import type { FileSpec, Target } from "@abhigyakrishna/tspgen-core";
import { apiDeclImports, organizeImports, qualifyDecl, resolveDeclImports } from "./imports.js";
import type { KotlinIR, KtDecl, KtTypeUse } from "./transform/model.js";
import { SERIALIZED_CLASSES, serializedIn } from "./transform/type-map.js";

/** Property types of a declaration, including those of variants nested in it. */
function declTypes(decl: KtDecl): KtTypeUse[] {
  if (decl.kind === "value-class") return [decl.value];
  // Events classes are not serialized: their payloads are encoded by the server and client routes.
  if (decl.kind === "typealias" || decl.kind === "enum" || decl.kind === "events") return [];
  const own = decl.properties.map((p) => p.type);
  return decl.kind === "sealed-interface" ? [...own, ...decl.variants.flatMap(declTypes)] : own;
}

const USE_SERIALIZERS = "kotlinx.serialization.UseSerializers";

function simpleName(fqn: string): string {
  return fqn.slice(fqn.lastIndexOf(".") + 1);
}

/** Serializers for classes kotlinx has none for, plus modelSerializersModule registering them contextually. */
function modelSerializersFile(ir: KotlinIR): FileSpec[] {
  const valueClassAsString = ir.valueClassAsString ?? [];
  if (ir.serializers.length === 0 && !ir.ulongAsString && valueClassAsString.length === 0) return [];
  const time = ir.serializers.filter((fqn) => fqn.startsWith("java.time."));
  const bigDecimal = ir.serializers.includes("java.math.BigDecimal");
  // PrimitiveSerialDescriptor/PrimitiveKind are only used by the java.time / BigDecimal / ULongAsString blocks
  // below (the value-class-as-string block delegates to another serializer's descriptor instead).
  const primitiveDescriptor = time.length > 0 || bigDecimal || ir.ulongAsString === true;
  const needsLongAsString = valueClassAsString.some((v) => v.wraps === "Long");
  return [
    {
      path: `models/${ir.modelsPackage.replaceAll(".", "/")}/ModelSerializers.kt`,
      template: "kotlin/file",
      data: {
        package: ir.modelsPackage,
        imports: organizeImports(
          [
            ...ir.serializers,
            ...valueClassAsString.map((v) => v.fqn),
            "kotlinx.serialization.KSerializer",
            ...(primitiveDescriptor
              ? ["kotlinx.serialization.descriptors.PrimitiveKind", "kotlinx.serialization.descriptors.PrimitiveSerialDescriptor"]
              : []),
            "kotlinx.serialization.descriptors.SerialDescriptor",
            "kotlinx.serialization.encoding.Decoder",
            "kotlinx.serialization.encoding.Encoder",
            ...(ir.serializers.length > 0 ? ["kotlinx.serialization.modules.SerializersModule"] : []),
            ...(bigDecimal ? ["kotlinx.serialization.json.JsonDecoder", "kotlinx.serialization.json.jsonPrimitive"] : []),
            ...(needsLongAsString ? ["kotlinx.serialization.builtins.LongAsStringSerializer"] : []),
          ],
          ir.modelsPackage,
        ),
        body: "kotlin/model/model-serializers",
        classes: time.map((fqn) => ({ fqn, name: simpleName(fqn) })),
        bigDecimal,
        contextual: ir.serializers.map(simpleName),
        ulongAsString: ir.ulongAsString === true,
        valueClassAsString: valueClassAsString.map((v) => ({ name: v.name, className: simpleName(v.fqn), wraps: v.wraps })),
      },
    },
  ];
}

/** `HttpFile`, the Kotlin type of `Http.File` bodies and multipart file parts, when the API uses one. */
function httpFileFile(ir: KotlinIR): FileSpec[] {
  if (!ir.httpFile) return [];
  return [
    {
      path: `models/${ir.modelsPackage.replaceAll(".", "/")}/HttpFile.kt`,
      template: "kotlin/file",
      data: { package: ir.modelsPackage, imports: [], body: "kotlin/model/http-file" },
    },
  ];
}

/**
 * `const val API_VERSION` (one per versioned service) in the models package, when a service is versioned. The
 * file is `ApiVersionConstants.kt`: version enums are often named `ApiVersion` (`ApiVersion.kt`).
 */
function apiVersionFile(ir: KotlinIR): FileSpec[] {
  if (ir.apiVersions.length === 0) return [];
  return [
    {
      path: `models/${ir.modelsPackage.replaceAll(".", "/")}/ApiVersionConstants.kt`,
      template: "kotlin/file",
      data: { package: ir.modelsPackage, imports: [], body: "kotlin/model/api-version", constants: ir.apiVersions },
    },
  ];
}

/** `SseMessage`, the element of untyped server-sent event streams, when an operation streams them. */
function sseMessageFile(ir: KotlinIR): FileSpec[] {
  if (!ir.sseMessage) return [];
  return [
    {
      path: `models/${ir.modelsPackage.replaceAll(".", "/")}/SseMessage.kt`,
      template: "kotlin/file",
      data: { package: ir.modelsPackage, imports: [], body: "kotlin/model/sse-message" },
    },
  ];
}

/** Built-in target: one Kotlin file per declaration under `models/`. */
export const modelsTarget: Target<KotlinIR> = {
  name: "kotlin-models",
  kind: "models",
  language: "kotlin",
  files: (ir) => {
    const declFiles = ir.declarations.map((decl): FileSpec => {
      const resolved = resolveDeclImports(decl);
      const { qualified } = resolved;
      let { imports } = resolved;
      // Classes without kotlinx serializers: register the generated ones for the whole file, which also covers
      // them as type arguments (List<Instant>) and map values.
      const used = new Set(declTypes(decl).flatMap(serializedIn));
      const custom = SERIALIZED_CLASSES.filter((fqn) => used.has(fqn));
      const serializers = custom.map((fqn) => `${ir.modelsPackage}.${simpleName(fqn)}Serializer`);
      if (custom.length > 0) {
        imports = organizeImports([...imports, USE_SERIALIZERS, ...serializers], decl.package);
      }
      return {
        path: `models/${decl.package.replaceAll(".", "/")}/${decl.name}.kt`,
        template: "kotlin/file",
        data: {
          package: decl.package,
          imports,
          qualified,
          ...(custom.length > 0
            ? { fileAnnotations: [`UseSerializers(${serializers.map((s) => `${simpleName(s)}::class`).join(", ")})`] }
            : {}),
          body: `kotlin/model/${decl.kind}`,
          decl: qualifyDecl(decl, qualified),
        },
      };
    });
    return [...declFiles, ...httpFileFile(ir), ...sseMessageFile(ir), ...modelSerializersFile(ir), ...apiVersionFile(ir), ...apiFiles(ir)];
  },
};

function apiFiles(ir: KotlinIR): FileSpec[] {
  return [
    ...ir.apiDeclarations.map((decl) => ({
      path: `models/${decl.package.replaceAll(".", "/")}/${decl.name}.kt`,
      template: "kotlin/file",
      data: { package: decl.package, imports: apiDeclImports(decl), body: `kotlin/api/${decl.kind}`, decl },
    })),
  ];
}
