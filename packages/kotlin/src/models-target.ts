import type { FileSpec, Target } from "@abhigyakrishna/tspgen-core";
import { apiDeclImports, organizeImports, qualifyDecl, resolveDeclImports } from "./imports.js";
import type { KotlinIR, KtDecl, KtTypeUse } from "./transform/model.js";
import { JAVA_TIME_CLASSES, javaTimeIn } from "./transform/type-map.js";

/** Property types of a declaration, including those of variants nested in it. */
function declTypes(decl: KtDecl): KtTypeUse[] {
  if (decl.kind === "typealias" || decl.kind === "enum") return [];
  const own = decl.properties.map((p) => p.type);
  return decl.kind === "sealed-interface" ? [...own, ...decl.variants.flatMap(declTypes)] : own;
}

const USE_SERIALIZERS = "kotlinx.serialization.UseSerializers";

function simpleName(fqn: string): string {
  return fqn.slice(fqn.lastIndexOf(".") + 1);
}

/**
 * ISO-8601 serializers for the java.time classes the API uses, plus a SerializersModule registering them
 * contextually (for bodies that are java.time values themselves), in one file of the models package.
 */
function javaTimeSerializersFile(ir: KotlinIR): FileSpec[] {
  const classes = ir.javaTime;
  if (classes.length === 0) return [];
  return [
    {
      path: `models/${ir.modelsPackage.replaceAll(".", "/")}/JavaTimeSerializers.kt`,
      template: "kotlin/file",
      data: {
        package: ir.modelsPackage,
        imports: organizeImports(
          [
            ...classes,
            "kotlinx.serialization.KSerializer",
            "kotlinx.serialization.descriptors.PrimitiveKind",
            "kotlinx.serialization.descriptors.PrimitiveSerialDescriptor",
            "kotlinx.serialization.descriptors.SerialDescriptor",
            "kotlinx.serialization.encoding.Decoder",
            "kotlinx.serialization.encoding.Encoder",
            "kotlinx.serialization.modules.SerializersModule",
          ],
          ir.modelsPackage,
        ),
        body: "kotlin/model/java-time-serializers",
        classes: classes.map((fqn) => ({ fqn, name: simpleName(fqn) })),
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
      // java.time has no kotlinx serializers: register the generated ones for the whole file, which
      // also covers them as type arguments (List<Instant>) and map values.
      const used = new Set(declTypes(decl).flatMap(javaTimeIn));
      const time = JAVA_TIME_CLASSES.filter((fqn) => used.has(fqn));
      const serializers = time.map((fqn) => `${ir.modelsPackage}.${simpleName(fqn)}Serializer`);
      if (time.length > 0) {
        imports = organizeImports([...imports, USE_SERIALIZERS, ...serializers], decl.package);
      }
      return {
        path: `models/${decl.package.replaceAll(".", "/")}/${decl.name}.kt`,
        template: "kotlin/file",
        data: {
          package: decl.package,
          imports,
          qualified,
          ...(time.length > 0
            ? { fileAnnotations: [`UseSerializers(${serializers.map((s) => `${simpleName(s)}::class`).join(", ")})`] }
            : {}),
          body: `kotlin/model/${decl.kind}`,
          decl: qualifyDecl(decl, qualified),
        },
      };
    });
    return [...declFiles, ...httpFileFile(ir), ...javaTimeSerializersFile(ir), ...apiVersionFile(ir), ...apiFiles(ir)];
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
