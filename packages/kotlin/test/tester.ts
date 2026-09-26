import { resolvePath } from "@typespec/compiler";
import { createTester } from "@typespec/compiler/testing";

export const Tester = createTester(resolvePath(import.meta.dirname, ".."), {
  libraries: ["@typespec/http", "@tspgen/emitter-core", "@tspgen/emitter-kotlin"],
})
  .importLibraries()
  .using("Http");

export function emitter(options: Record<string, unknown> = {}) {
  return Tester.emit("@tspgen/emitter-kotlin", { package: "com.acme", ...options });
}
