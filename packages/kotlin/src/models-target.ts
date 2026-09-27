import type { FileSpec, Target } from "@abhigyakrishna/tspgen-core";
import { apiDeclImports, organizeImports, qualifyDecl, resolveDeclImports } from "./imports.js";
import type { KotlinIR } from "./transform/model.js";
import { JAVA_TIME_CLASSES } from "./transform/type-map.js";

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
      const time = decl.kind === "typealias" ? [] : JAVA_TIME_CLASSES.filter((fqn) => [...imports, ...qualified].includes(fqn));
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
    return [...declFiles, ...javaTimeSerializersFile(ir), ...apiFiles(ir)];
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
