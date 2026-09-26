import "../dist/tsp-index.js";
import "@specgen/emitter-core";

using TypeSpec.Reflection;

namespace Kotlin;

/** Override the generated Kotlin identifier. */
extern dec name(target: unknown, value: valueof string);

/** Add an annotation (Kotlin source, e.g. `@Suppress("unused")`) to the generated declaration. */
extern dec annotate(target: unknown, annotation: valueof string);

/** Map this type or property to a fully-qualified Kotlin type, e.g. `java.util.UUID`. */
extern dec type(target: Model | ModelProperty | Scalar | Enum | Union, fqn: valueof string);

/** Place the generated declaration in the given Kotlin package. */
extern dec packageName(target: Model | Enum | Union, value: valueof string);
