import { resolvePath } from "@typespec/compiler";
import { createTester } from "@typespec/compiler/testing";

export const Tester = createTester(resolvePath(import.meta.dirname, ".."), {
  libraries: ["@typespec/http", "@abhigyakrishna/tspgen-core", "@abhigyakrishna/tspgen-kotlin"],
})
  .importLibraries()
  .using("Http");

export function emitter(options: Record<string, unknown> = {}) {
  return Tester.emit("@abhigyakrishna/tspgen-kotlin", { package: "com.acme", ...options });
}

/** Tester with the optional SSE libraries (`@typespec/streams`, `@typespec/events`, `@typespec/sse`). */
export const SseTester = createTester(resolvePath(import.meta.dirname, ".."), {
  libraries: [
    "@typespec/http",
    "@typespec/streams",
    "@typespec/events",
    "@typespec/sse",
    "@abhigyakrishna/tspgen-core",
    "@abhigyakrishna/tspgen-kotlin",
  ],
})
  .importLibraries()
  .using("Http", "SSE", "Events");
