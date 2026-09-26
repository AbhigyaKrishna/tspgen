import type { DecoratorContext, Type } from "@typespec/compiler";

export { $lib } from "./lib.js";

// Decorator data is read generically from the IR (core collectDecorators); implementations only
// need to exist so the compiler validates usage.
function noop(_context: DecoratorContext, _target: Type, _value: string): void {}

export const $decorators = {
  Kotlin: { name: noop, annotate: noop, type: noop, packageName: noop },
};
