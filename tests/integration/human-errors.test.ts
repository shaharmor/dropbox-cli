import { test, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
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
