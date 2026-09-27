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

  it("keeps an entry per owner, so emitters sharing a directory only delete their own files", async () => {
    const { program } = await Tester.compile(`model M {}`);
    const out = resolveVirtualPath("shared");
    const read = async (p: string) => (await program.host.readFile(resolvePath(out, p))).text;

    await writeOutputs(program, out, [{ path: "kotlin.txt", content: "K" }, { path: "both.txt", content: "K" }], { owner: "kotlin" });
    await writeOutputs(program, out, [{ path: "ts.txt", content: "T" }, { path: "both.txt", content: "T" }], { owner: "typescript" });
    await writeOutputs(program, out, [{ path: "kotlin.txt", content: "K2" }], { owner: "kotlin" });
    expect(await read("ts.txt")).toBe("T");
    // Still listed by typescript, so kotlin dropping it does not delete it.
    expect(await read("both.txt")).toBe("T");
    expect(JSON.parse(await read(MANIFEST_FILE))).toEqual({
      files: ["both.txt", "kotlin.txt", "ts.txt"],
      owners: { kotlin: { files: ["kotlin.txt"] }, typescript: { files: ["both.txt", "ts.txt"] } },
    });
  });

  it("adopts a 0.1 manifest and removes the manifest once nothing is left", async () => {
    const { program } = await Tester.compile(`model M {}`);
    const out = resolveVirtualPath("legacy");
    const read = async (p: string) => (await program.host.readFile(resolvePath(out, p))).text;
    await writeOutputs(program, out, [{ path: "old.txt", content: "O" }]);
    await writeOutputs(program, out, [], { owner: "kotlin" });
    await expect(read("old.txt")).rejects.toThrow();
    await expect(read(MANIFEST_FILE)).rejects.toThrow();
  });
});
