import type { DecoratorContext, Type } from "@typespec/compiler";

export { $lib } from "./lib.js";

// Decorator data is read generically from the IR (core collectDecorators).
function noop(_context: DecoratorContext, _target: Type, ..._args: unknown[]): void {}

export const $decorators = {
  TS: { name: noop, type: noop },
};
