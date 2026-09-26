import "../dist/tsp-index.js";
import "@specgen/emitter-core";

using TypeSpec.Reflection;

namespace TS;

/** Override the generated TypeScript type name. */
extern dec name(target: unknown, value: valueof string);

/** Map this type or property to an external TypeScript type, optionally imported from `module`. */
extern dec type(target: Model | ModelProperty | Scalar | Enum | Union, name: valueof string, module?: valueof string);
