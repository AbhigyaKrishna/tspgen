import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function runGo(outputs: Record<string, string>, tests: Record<string, string>): void {
  const directory = mkdtempSync(join(tmpdir(), "tspgen-go-test-"));
  try {
    for (const [path, content] of Object.entries({ ...outputs, ...tests })) {
      const file = join(directory, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    const modules = Object.keys(outputs).filter((path) => path.endsWith("/go.mod")).map(dirname);
    writeFileSync(join(directory, "go.work"), `go 1.27\n\nuse (\n${modules.map((path) => `./${path}`).join("\n")}\n)\n`);
    for (const module of modules) {
      try {
        execFileSync("go", ["test", "./..."], {
          cwd: join(directory, module),
          env: { ...process.env, GOWORK: join(directory, "go.work"), GOTOOLCHAIN: "local" },
          encoding: "utf8", stdio: "pipe", timeout: 150000,
        });
      } catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string };
        throw new Error(`${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`, { cause: error });
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
