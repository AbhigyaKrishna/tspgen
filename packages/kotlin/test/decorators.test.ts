import { describe, expect, it } from "vitest";
import { buildApiIR } from "@tspgen/emitter-core";
import { Tester } from "./tester.js";

describe("Kotlin decorators", () => {
  it("compiles and surfaces decorator data in the IR", async () => {
    const { program } = await Tester.compile(`
      @service namespace S {
        @Kotlin.name("Customer") @Kotlin.annotate("@Suppress(\\"unused\\")")
        model User { @Kotlin.type("java.util.UUID") id: string }
      }
    `);
    const user = buildApiIR(program).types.find((t) => t.id === "S.User");
    expect(user?.decorators).toEqual({
      "Kotlin.name": [["Customer"]],
      "Kotlin.annotate": [[`@Suppress("unused")`]],
    });
  });
});
