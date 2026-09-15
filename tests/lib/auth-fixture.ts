import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

// Each worker loads real modules in a fresh process, not Bun's shared mock registry.
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dropbox-auth-fixture-"));
  const source = pathToFileURL(join(import.meta.dir, "../../src/")).href;
  const children: ReturnType<typeof Bun.spawn>[] = [];
  let sequence = 0;
  function start(code: string) {
    const script = join(root, `worker-${sequence++}.ts`);
    writeFileSync(script, `
      import { strict as assert } from 'node:assert';
      import { existsSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
      import { join } from 'node:path';
      globalThis.fetch = (() => { throw new Error('Live network denied'); });
      Bun.spawn = (() => { throw new Error('Browser/process launch denied in fixture'); });
      const root = ${JSON.stringify(root)};
      const config = await import(${JSON.stringify(source + "lib/config.ts")});
      const auth = await import(${JSON.stringify(source + "lib/auth.ts")});
      const api = await import(${JSON.stringify(source + "lib/api.ts")});
      const fake = { access_token: 'fake-A', refresh_token: 'fake-refresh', expires_at: Math.floor(Date.now()/1000)+3600, account_id: 'A', account_email: 'a@example.invalid' };
      const app = { client_id: 'fake-client', client_secret: 'fake-secret' };
      const waitFor = async (name) => { const until = Date.now()+10000; while(!existsSync(join(root,name))) { if(Date.now()>until) throw new Error('Barrier timed out: '+name); await Bun.sleep(10); } };
      ${code}
    `);
    const child = Bun.spawn([process.execPath, script], {
      cwd: root,
      env: { HOME: root, DROPBOX_CLI_CONFIG_DIR: join(root, "config"), PATH: process.env.PATH },
      stdout: "pipe", stderr: "pipe",
    });
    children.push(child);
    // Drain both pipes immediately, including workers deliberately held at barriers.
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    return { child, result: async () => ({ exit: await child.exited, stdout: await stdout, stderr: await stderr }) };
  }
  return { root, start, async run(code: string) { return start(code).result(); }, async close() {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.all(children.map(child => child.exited));
    rmSync(root, { recursive: true, force: true });
  } };
}
