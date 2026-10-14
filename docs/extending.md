# Adding a language or library

- **New server/client library for an existing language:** publish a package whose default export is a
  `Target<KotlinIR>` (`name`, `kind`, `language: "kotlin"`, `templates`, `helpers`, `optionsSchema`,
  `files(ir, ctx)`), then list it under `targets`. See `packages/kotlin-ktor-client` for a compact example. A
  target can declare its own on/off gates with `features` (a `FeatureSet`, merged into `optionsSchema.properties.features`
  and read from `ctx.features` in `files(ir, ctx)`) and rename option keys moved since an earlier release with
  `movedOptions` (checked before the target's own options are validated):
  ```ts
  export default {
    name: "my-server",
    kind: "server",
    language: "kotlin",
    files(ir, ctx) { return ctx.features.values.retries ? [/* … */] : [/* … */]; },
    features: defineFeatures({ retries: { default: false, description: "Retry failed requests." } }),
    movedOptions: { "old-key": "new-key" },
  } satisfies Target<KotlinIR>;
  ```
- **New language:** create an emitter package with a `LanguageModule` (`transform(apiIR) → YourIR`,
  base `templates`, `helpers`, optional `format`) and a built-in models target, and call `runPipeline`
  from `$onEmit`. Core (IR, plugins, templates, targets, manifest) is reused unchanged.
