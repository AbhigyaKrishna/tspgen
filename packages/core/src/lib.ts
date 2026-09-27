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
    "unsupported-encoding": {
      severity: "warning",
      messages: {
        default: paramMessage`@encode("${"encoding"}") on '${"where"}' is not supported; the default JSON encoding is used.`,
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
    "unknown-version": {
      severity: "error",
      messages: {
        default: paramMessage`Version '${"version"}' is not a version of service '${"service"}'; valid versions: ${"versions"}. Nothing is generated.`,
      },
    },
    "unused-version": {
      severity: "warning",
      messages: {
        default: paramMessage`Option 'version' is '${"version"}' but no service is versioned (@versioned); it is ignored.`,
      },
    },
    "version-conflict": {
      severity: "warning",
      messages: {
        default: paramMessage`Type '${"id"}' is used by several services at different versions; the first one is generated.`,
      },
    },
    "sse-libraries-missing": {
      severity: "warning",
      messages: {
        default: paramMessage`Operation '${"operation"}' streams typed server-sent events, but tspgen could not load @typespec/streams, @typespec/events and @typespec/sse; install them next to tspgen. The events are generated untyped (SseMessage).`,
      },
    },
    "unsupported-sse-response": {
      severity: "warning",
      messages: {
        default: paramMessage`Operation '${"operation"}' returns a text/event-stream response together with other success responses or response headers; only a single success response can stream. It is treated as a text body.`,
      },
    },
    "events-in-json": {
      severity: "warning",
      messages: {
        default: paramMessage`@events union '${"union"}' is used as a regular type (${"where"}); it is generated as an event type for server-sent event streams and can't be serialized as JSON.`,
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
    "unknown-feature": {
      severity: "error",
      messages: {
        default: paramMessage`Unknown feature '${"key"}' for ${"emitter"}; known: ${"known"}.`,
      },
    },
    "duplicate-feature": {
      severity: "error",
      messages: {
        default: paramMessage`Feature '${"key"}' is declared by both ${"first"} and ${"second"}.`,
      },
    },
    "unsupported-feature": {
      severity: "warning",
      messages: {
        default: paramMessage`\`features.${"key"}\` has no effect with ${"reason"}.`,
        option: paramMessage`\`${"key"}\` has no effect ${"reason"}.`,
      },
    },
    "option-moved": {
      severity: "error",
      messages: {
        default: paramMessage`\`${"key"}\` moved to \`${"to"}\` in 0.2.0.`,
      },
    },
    "unsupported-auth-combination": {
      severity: "error",
      messages: {
        default: paramMessage`Operation '${"operation"}' requires ${"requirement"}, which ${"target"} cannot express; it requires ${"fallback"} instead. Set its auth explicitly with ${"hint"}.`,
      },
    },
    "auth-combination-approximated": {
      severity: "warning",
      messages: {
        default: paramMessage`Operation '${"operation"}' requires ${"requirement"}; ${"target"} generates ${"wrapper"}, which lets anonymous calls through and accepts the first valid credential without checking the others, so one scheme of a combination is enough. Set its auth explicitly with ${"hint"} to silence this.`,
      },
    },
    "auth-wrapper-not-rendered": {
      severity: "warning",
      messages: {
        default: paramMessage`Operation '${"operation"}' needs ${"wrapper"}, but ${"where"} may render only the provider names in ServerOpExtras.authenticate, dropping its strategy, optional flag or provider expressions; render ServerOpExtras.auth (or authProviders, authStrategy and authOptional) there.`,
      },
    },
    "unknown-auth-provider": {
      severity: "warning",
      messages: {
        default: paramMessage`auth-providers maps '${"key"}', which is no auth scheme id (scheme ids: ${"ids"}; a different scheme reusing an id gets '_' appended, e.g. ApiKeyAuth_); it is unused.`,
      },
    },
    "unsupported-auth-scheme": {
      severity: "warning",
      messages: {
        default: paramMessage`Auth scheme '${"scheme"}' (${"kind"}) is not supported by ${"target"}; alternatives needing it are ignored.`,
      },
    },
    "auth-header-conflict": {
      severity: "warning",
      messages: {
        default: paramMessage`Operation '${"operation"}' sends several credentials (${"schemes"}) as the '${"header"}' header in one auth alternative; ${"target"} sends only the last one.`,
        parameter: paramMessage`Operation '${"operation"}' has a '${"header"}' ${"location"} parameter, which auth scheme '${"scheme"}' also sends; ${"target"} sends the credential instead.`,
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
