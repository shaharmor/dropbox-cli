import { expect, test } from "bun:test";
import { join } from "path";
import pkg from "../../package.json";

test("--version prints the package.json version", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../src/index.ts"), "--version"], {
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(exit).toBe(0);
  expect(stdout.trim()).toBe(pkg.version);
});
