import type { DecoratorContext, Type } from "@typespec/compiler";

export { $lib } from "./lib.js";

// Metadata is read generically from the IR (collectDecorators); the implementation only validates usage.
function meta(_context: DecoratorContext, _target: Type, _scope: string, _data: unknown): void {}

export const $decorators = {
  TspGen: { meta },
};
