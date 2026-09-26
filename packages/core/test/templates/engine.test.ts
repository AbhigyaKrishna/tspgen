import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { TemplateEngine, TemplateNotFoundError } from "../../src/index.js";

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "tspgen-tpl-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

describe("TemplateEngine", () => {
  const base = dirWith({
    "greet/file.eta": `<%~ include("greet/header", it) %>|Hello <%= it.name %>|<%= it.h.shout(it.name) %>`,
    "greet/header.eta": "BASE",
  });
  const user = dirWith({ "greet/header.eta": "USER" });

  it("renders with helpers and includes", () => {
    const engine = new TemplateEngine([{ name: "base", dir: base }], { shout: (s: string) => s.toUpperCase() });
    expect(engine.render("greet/file", { name: "Bob" })).toBe("BASE|Hello Bob|BOB");
  });

  it("lets earlier layers override included partials", () => {
    const engine = new TemplateEngine(
      [
        { name: "user", dir: user },
        { name: "base", dir: base },
      ],
      { shout: (s: string) => s.toUpperCase() },
    );
    expect(engine.render("greet/file", { name: "Bob" })).toBe("USER|Hello Bob|BOB");
    expect(engine.resolve("greet/header").layer).toBe("user");
    expect(engine.resolve("greet/file").layer).toBe("base");
  });

  it("throws TemplateNotFoundError for unknown templates", () => {
    const engine = new TemplateEngine([{ name: "base", dir: base }]);
    expect(() => engine.resolve("nope")).toThrow(TemplateNotFoundError);
  });
});
