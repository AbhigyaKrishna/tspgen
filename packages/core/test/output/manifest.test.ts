import { resolvePath } from "@typespec/compiler";
import { resolveVirtualPath } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import { MANIFEST_FILE, writeOutputs } from "../../src/index.js";
import { Tester } from "../tester.js";

describe("writeOutputs", () => {
  it("writes files and a manifest, and removes only stale generated files", async () => {
    const { program } = await Tester.compile(`model M {}`);
    const out = resolveVirtualPath("out");
    const read = async (p: string) => (await program.host.readFile(resolvePath(out, p))).text;

    await writeOutputs(program, out, [
      { path: "a.txt", content: "A" },
      { path: "sub/b.txt", content: "B" },
    ]);
    await program.host.writeFile(resolvePath(out, "user.txt"), "mine");
    expect(await read("a.txt")).toBe("A");
    expect(JSON.parse(await read(MANIFEST_FILE))).toEqual({ files: ["a.txt", "sub/b.txt"] });

    await writeOutputs(program, out, [{ path: "a.txt", content: "A2" }]);
    expect(await read("a.txt")).toBe("A2");
    await expect(read("sub/b.txt")).rejects.toThrow();
    expect(await read("user.txt")).toBe("mine");
    expect(JSON.parse(await read(MANIFEST_FILE))).toEqual({ files: ["a.txt"] });
  });
});
