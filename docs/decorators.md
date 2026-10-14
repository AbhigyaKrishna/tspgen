# Decorators

```tsp
import "@abhigyakrishna/tspgen-kotlin";

@Kotlin.name("Customer")                 // rename the generated declaration/property/operation
@Kotlin.annotate("@Suppress(\"unused\")") // add annotations (repeatable)
model User {
  @Kotlin.type("java.util.UUID") id: string;   // map to any Kotlin type (import added)
}

@Kotlin.packageName("com.acme.shared")    // place a model/enum/union in another package
model Money { amount: string }
```

`@Kotlin.type` on a templated model maps every instance with its arguments
(`@@Kotlin.type(Shop.Page, "com.acme.core.Page")` → `Page<Node>`), and on a scalar maps every use of it
(`@@Kotlin.type(Shop.isoInstant, "com.acme.core.IsoInstant")`). Mapped types are never generated.

TypeScript: `@TS.name("Customer")` renames a generated type; `@TS.type("Decimal", "decimal.js")` maps a
model, scalar, enum, union or property to an external type (module optional, e.g. `@TS.type("Date")`). A
module starting with `.` is resolved from the emitter's output root and rebased into a relative import for
each generated file; any other module (a package name) is used verbatim. `@TS.type` on a templated model maps
every instance with its arguments (`@@TS.type(Shop.Page, "Page", "../page")` → `Page<Node>`, imported from
`../page` relative to the output root); mapped types are never generated.

> **Behaviour change**: relative `@TS.type` modules (starting with `.`) are now resolved from the emitter's
> output root and rebased per file. Previously they were used verbatim, i.e. relative to each importing file,
> which broke for any file not at the output root (e.g. `models/<Name>.ts` or `api/*.ts`).
