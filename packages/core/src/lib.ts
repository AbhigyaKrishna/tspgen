import { createTypeSpecLibrary, paramMessage } from "@typespec/compiler";

export const $lib = createTypeSpecLibrary({
  name: "@abhigyakrishna/tspgen-core",
  diagnostics: {
    "unsupported-type": {
      severity: "warning",
      messages: {
        default: paramMessage`Type kind '${"kind"}' is not supported; it will be emitted as unknown.`,
      },
    },
    "unsupported-multipart-tuple": {
      severity: "error",
      messages: {
        default: paramMessage`Operation '${"operation"}' uses a tuple-form @multipartBody, which is not supported; use a model with HttpPart properties. The operation is skipped.`,
      },
    },
    "unsupported-multipart-base": {
      severity: "error",
      messages: {
        default: paramMessage`Multipart body model '${"model"}' of operation '${"operation"}' extends '${"base"}', whose parts TypeSpec ignores; spread the base instead (\`...${"baseName"}\`). The operation is skipped.`,
      },
    },
    "file-in-json": {
      severity: "warning",
      messages: {
        default: paramMessage`Model '${"model"}' uses an Http.File type outside a multipart part; file types can't be serialized as JSON.`,
        response: paramMessage`Operation '${"operation"}' returns an Http.File type; file responses are not supported and file types can't be serialized as JSON.`,
      },
    },
    "multipart-model-in-json": {
      severity: "warning",
      messages: {
        default: paramMessage`Multipart model '${"model"}' is also used as JSON (${"where"}); it is generated for multipart only and can't be serialized as JSON.`,
      },
    },
    "template-error": {
      severity: "error",
      messages: {
        default: paramMessage`Failed to render template '${"template"}' for file '${"file"}': ${"message"}`,
      },
    },
    "duplicate-file": {
      severity: "error",
      messages: {
        default: paramMessage`Output file '${"file"}' is produced more than once.`,
      },
    },
    "invalid-target-options": {
      severity: "error",
      messages: {
        default: paramMessage`Invalid options for target '${"name"}': ${"errors"}`,
      },
    },
    "invalid-meta": {
      severity: "warning",
      messages: {
        default: paramMessage`Metadata key '${"key"}' on '${"where"}' must be ${"expected"}; it is ignored.`,
      },
    },
    "module-load-failed": {
      severity: "error",
      messages: {
        default: paramMessage`Failed to load ${"kind"} '${"specifier"}': ${"message"}`,
      },
    },
    "plugin-failed": {
      severity: "error",
      messages: {
        default: paramMessage`Plugin '${"name"}' failed during ${"stage"}: ${"message"}`,
      },
    },
    "target-failed": {
      severity: "error",
      messages: {
        default: paramMessage`Target '${"name"}' failed during ${"stage"}: ${"message"}`,
      },
    },
  },
});

export const { reportDiagnostic, createDiagnostic } = $lib;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
