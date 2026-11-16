import { test, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { existsSync, readdirSync, realpathSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { fixture, PROCESS_TEST_TIMEOUT_MS } from "../lib/auth-fixture";

setDefaultTimeout(PROCESS_TEST_TIMEOUT_MS);

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(async () => { await f.close(); });

const entry = pathToFileURL(join(import.meta.dir, "../../src/index.ts")).href;

async function cli(args: string[], setup: string) {
  return f.run(`${setup}\nprocess.argv=['bun','dropbox-cli',...${JSON.stringify(args)}]; await import(${JSON.stringify(entry)});`);
}

function envelope(code: string, message: string): string {
  return JSON.stringify({ ok: false, error: { code, message } }, null, 2) + "\n";
}

test("a Dropbox API error prints the error envelope and exits 1", async () => {
  const out = await cli(["info", "/Documents/example.txt"], `config.writeConfig(app); config.writeAuth(fake);
    globalThis.fetch=async()=>Response.json({error:{'.tag':'path',path:{'.tag':'not_found'}},error_summary:'path/not_found/.'},{status:409});`);
  expect(out).toEqual({ exit: 1, stdout: envelope("path", "path/not_found/."), stderr: "" });
});

test("a refused authentication prints auth_error and exits 2", async () => {
  const out = await cli(["mkdir", "/Documents/example"], `config.writeConfig(app); config.writeAuth(fake);
    globalThis.fetch=async()=>Response.json({error:{'.tag':'invalid_access_token'}},{status:401});`);
  expect(out).toEqual({
    exit: 2,
    stdout: envelope("auth_error", "Dropbox authentication was refused. Reconnect the account."),
    stderr: "",
  });
});

test("a failed token refresh keeps its own code and exits 2", async () => {
  const out = await cli(["info", "/Documents/example.txt"], `config.writeConfig(app); config.writeAuth({...fake,expires_at:1});
    globalThis.fetch=async()=>new Response('{}',{status:503});`);
  expect(out).toEqual({
    exit: 2,
    stdout: envelope("connection_error", "Cannot refresh credentials. Check the connection and retry."),
    stderr: "",
  });
});

test("a failed batch job prints batch_error and exits 1", async () => {
  const out = await cli(["cp", "/a.txt", "/b.txt", "/Backup"], `config.writeConfig(app); config.writeAuth(fake);
    globalThis.fetch=async(url)=>String(url).endsWith('/files/copy_batch_v2')
      ? Response.json({'.tag':'async_job_id',async_job_id:'fake-job'})
      : Response.json({'.tag':'failed'});`);
  expect(out).toEqual({ exit: 1, stdout: envelope("batch_error", "Batch job failed: failed"), stderr: "" });
});

test("ls rejects --limit with --type as command_failed and exits 1", async () => {
  const out = await cli(["ls", "/Documents", "--limit", "5", "--type", "file"], "");
  expect(out).toEqual({
    exit: 1,
    stdout: envelope("command_failed", "--limit and --type cannot be used together"),
    stderr: "",
  });
});

test("an interrupted human download removes its staging file and exits with the signal code", async () => {
  for (const [signal, exit] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    const ready = `${signal}-ready`;
    const worker = f.start(`config.writeConfig(app); config.writeAuth(fake);
      globalThis.fetch=async()=>new Response(new ReadableStream({
        start(c){c.enqueue(new Uint8Array([1]));},
        pull(){writeFileSync(join(root,'${ready}'),'');return new Promise(r=>setTimeout(r,60000));},
      }),{headers:{'Dropbox-API-Result':JSON.stringify({name:'example.txt'})}});
      process.argv=['bun','dropbox-cli','download','/Documents/example.txt']; await import(${JSON.stringify(entry)});`);
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(f.root, ready))) {
      if (Date.now() > deadline) throw new Error("Fixture did not start");
      await Bun.sleep(10);
    }
    expect(readdirSync(f.root).some(name => name.endsWith(".part"))).toBe(true);
    worker.child.kill(signal);
    const out = await worker.result();
    expect({ exit: out.exit, stdout: out.stdout }).toEqual({ exit, stdout: "" });
    expect(readdirSync(f.root).some(name => name.endsWith(".part"))).toBe(false);
    expect(existsSync(join(f.root, "example.txt"))).toBe(false);
  }
});

test("machine download rejects --force with the invalid_args envelope before any request", async () => {
  const output = join(realpathSync(f.root), "example.txt");
  const out = await cli(
    ["download", "rev:r1", "--output-file", output, "--expected-id", "id:a", "--expected-account", "A", "--force"],
    `config.writeConfig(app); config.writeAuth(fake);
    globalThis.fetch=async()=>{writeFileSync(join(root,'fetched'),'');throw new Error('Denied request');};`,
  );
  expect(out).toEqual({
    exit: 1,
    stdout: '{"ok":false,"error":{"code":"invalid_args","message":"Invalid command arguments. Use --help for usage.","details":{"outcome":"not_submitted"}}}\n',
    stderr: "",
  });
  expect(existsSync(join(f.root, "fetched"))).toBe(false);
  expect(existsSync(output)).toBe(false);
});

test("a plain Error during a human download prints command_failed and leaves no file", async () => {
  const out = await cli(["download", "/Documents/example.txt"], `config.writeConfig(app); config.writeAuth(fake);
    globalThis.fetch=async()=>new Response(new ReadableStream({
      start(c){c.enqueue(new Uint8Array([1]));},
      pull(c){c.error(new Error('fake stream failure'));},
    }),{headers:{'Dropbox-API-Result':JSON.stringify({name:'example.txt'})}});`);
  expect(out).toEqual({ exit: 1, stdout: envelope("command_failed", "fake stream failure"), stderr: "" });
  expect(readdirSync(f.root).some(name => name.endsWith(".part"))).toBe(false);
  expect(existsSync(join(f.root, "example.txt"))).toBe(false);
});
