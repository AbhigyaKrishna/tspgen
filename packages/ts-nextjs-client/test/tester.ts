import { resolvePath } from "@typespec/compiler";
import { createTester } from "@typespec/compiler/testing";
import { resolve } from "node:path";

export const Tester = createTester(resolvePath(import.meta.dirname, ".."), {
  libraries: ["@typespec/http", "@abhigyakrishna/tspgen-core", "@abhigyakrishna/tspgen-typescript"],
})
  .importLibraries()
  .using("Http");

export const TARGET = resolve(import.meta.dirname, "../dist/index.js");

export function nextjs(targetOptions: Record<string, unknown> = {}, emitterOptions: Record<string, unknown> = {}) {
  return Tester.emit("@abhigyakrishna/tspgen-typescript", { targets: [{ [TARGET]: targetOptions }], ...emitterOptions });
}

export const petSpec = `
  @service namespace PetStore;
  enum Species { dog, cat }
  model Pet { id: int64; name: string; species: Species; born_at?: utcDateTime }
  @error model ApiError { code: string }
  @error model NotFound { @statusCode _: 404; message: string }
  @route("/pets") interface Pets {
    /** List pets */
    @get list(@query limit?: int32, @query(#{ explode: true }) tags?: string[], @query ids?: int32[]): Pet[] | ApiError;
    @get get(@path petId: int64, @header("x-trace") trace?: string, @cookie session?: string): Pet | NotFound | ApiError;
    @post create(@body pet: Pet): { @statusCode _: 201; @header location: string; @header("x-count") count?: int32; @body pet: Pet } | { @statusCode _: 200; @body pet: Pet };
    @delete remove(@path petId: int64): void | NotFound;
  }
  @route("/health") op health(): { status: string };
`;

/** Tester with the optional SSE libraries (`@typespec/streams`, `@typespec/events`, `@typespec/sse`). */
export const SseTester = createTester(resolvePath(import.meta.dirname, ".."), {
  libraries: [
    "@typespec/http",
    "@typespec/streams",
    "@typespec/events",
    "@typespec/sse",
    "@abhigyakrishna/tspgen-core",
    "@abhigyakrishna/tspgen-typescript",
  ],
})
  .importLibraries()
  .using("Http", "SSE", "Events");

export function sseNextjs(targetOptions: Record<string, unknown> = {}, emitterOptions: Record<string, unknown> = {}) {
  return SseTester.emit("@abhigyakrishna/tspgen-typescript", { targets: [{ [TARGET]: targetOptions }], ...emitterOptions });
}
