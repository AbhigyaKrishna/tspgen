import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Runtime tests import generated code (e.g. ts-nextjs-client's server-client.ts) directly, outside Next.js,
  // which resolves `server-only` itself.
  resolve: { alias: { "server-only": fileURLToPath(new URL("./packages/ts-nextjs-client/test/server-only-stub.ts", import.meta.url)) } },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 30000,
  },
});
