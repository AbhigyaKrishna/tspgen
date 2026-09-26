import { resolvePath } from "@typespec/compiler";
import { createTester } from "@typespec/compiler/testing";

export const Tester = createTester(resolvePath(import.meta.dirname, ".."), {
  libraries: ["@typespec/http", "@specgen/emitter-core", "@specgen/emitter-kotlin"],
})
  .importLibraries()
  .using("Http");

export function emitter(options: Record<string, unknown> = {}) {
  return Tester.emit("@specgen/emitter-kotlin", { package: "com.acme", ...options });
}
