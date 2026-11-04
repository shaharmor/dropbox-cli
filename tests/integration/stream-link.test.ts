import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { fixture } from "../lib/auth-fixture";

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(async () => { await f.close(); });
const entry = pathToFileURL(join(import.meta.dir, "../../src/index.ts")).href;
const hash = "a".repeat(64);
const link = "https://uc0.dl.dropboxusercontent.com/cd/0/get/temporary-token/file";
// The reviewed revision is r1; the file was since moved, so its current revision is r2 with the same content.
const setup = `config.writeConfig(app); config.writeAuth(fake);
  const video = {'.tag':'file',id:'id:video',name:'clip.mov',path_lower:'/videos/kept/clip.mov',path_display:'/Videos/kept/clip.mov',rev:'r2',size:10,content_hash:${JSON.stringify(hash)}};
  let current = () => Response.json(video);
  let temporary = () => Response.json({metadata:{...video,rev:'r1',path_lower:'/videos/clip.mov',path_display:'/Videos/clip.mov'},link:${JSON.stringify(link)}});
  globalThis.fetch = async (url, init) => {
    const endpoint = String(url).split('/2/')[1], body = JSON.parse(init.body);
    appendFileSync(join(root,'requests'), JSON.stringify({endpoint,body})+'\\n');
    assert.equal(String(url).startsWith('https://api.dropboxapi.com/2/'), true);
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer fake-A');
    if (endpoint === 'files/get_metadata') return current();
    if (endpoint === 'files/get_temporary_link') return temporary();
    throw new Error('Denied endpoint');
  };`;
const args = ["rev:r1", "--expected-id", "id:video", "--expected-current-rev", "r2", "--expected-hash", hash, "--expected-account", "A"];
const withoutHash = ["rev:r1", "--expected-id", "id:video", "--expected-current-rev", "r2", "--expected-account", "A"];

async function run(argv = args, script = "") {
  const out = await f.run(`${setup}\n${script}\nprocess.argv=['bun','dropbox-cli','stream-link',...${JSON.stringify(argv)}];await import(${JSON.stringify(entry)});`);
  return { ...out, result: JSON.parse(out.stdout) };
}
function calls() {
  const file = join(f.root, "requests");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
}
const metadataCall = { endpoint: "files/get_metadata", body: { path: "id:video", include_has_explicit_shared_members: true } };
const linkCall = { endpoint: "files/get_temporary_link", body: { path: "rev:r1" } };

test("a still-current video returns a verified revision-pinned link", async () => {
  const out = await run();
  expect(out.exit).toBe(0);
  expect(out.result).toEqual({ ok: true, data: { id: "id:video", rev: "r1", content_hash: hash, link } });
  expect(out.stdout).not.toContain("fake-A");
  // Metadata is read by ID, the link is minted for the reviewed revision, both with the bearer header.
  expect(calls()).toEqual([metadataCall, linkCall]);
});

test("a replaced video fails as identity_mismatch without minting a link", async () => {
  const out = await run(args, `current = () => Response.json({...video, content_hash:'b'.repeat(64)});`);
  expect(out.exit).not.toBe(0);
  expect(out.result.error.code).toBe("identity_mismatch");
  expect(calls()).toEqual([metadataCall]);
});

test("without an expected hash the current revision decides currency", async () => {
  const ok = await run(withoutHash);
  expect(ok.exit).toBe(0);
  expect(ok.result.data.link).toBe(link);
  const changed = await run(withoutHash, `current = () => Response.json({...video, rev:'r3'});`);
  expect(changed.exit).not.toBe(0);
  expect(changed.result.error.code).toBe("identity_mismatch");
  expect(calls()).toEqual([metadataCall, linkCall, metadataCall]);
});

test("link metadata for another file, revision or content is rejected without leaking the link", async () => {
  for (const change of ["id:'id:other'", "rev:'r9'", "content_hash:'b'.repeat(64)"]) {
    const out = await run(args, `const minted = temporary; temporary = async () => { const body = await minted().json(); return Response.json({...body, metadata:{...body.metadata, ${change}}}); };`);
    expect(out.exit).not.toBe(0);
    expect(out.result.error.code).toBe("identity_mismatch");
    expect(out.stdout + out.stderr).not.toContain("temporary-token");
  }
});

test("a non-https, malformed or oversized link is an invalid response", async () => {
  for (const bad of ["'http://uc0.dl.dropboxusercontent.com/temporary-token'", "'not a temporary-token url'", "'https://uc0.dl.dropboxusercontent.com/temporary-token/'+'a'.repeat(4096)", "42"]) {
    const out = await run(args, `const minted = temporary; temporary = async () => Response.json({...await minted().json(), link:${bad}});`);
    expect(out.exit).not.toBe(0);
    expect(out.result.error.code).toBe("invalid_response");
    expect(out.stdout + out.stderr).not.toContain("temporary-token");
  }
});

test("invalid arguments fail with a static message before any request", async () => {
  const secret = "argv-secret";
  const cases = [
    ["rev:r1", "--expected-current-rev", "r2", "--expected-account", "A"],
    ["rev:r1", "--expected-id", secret, "--expected-current-rev", "r2", "--expected-account", "A"],
    ["rev:r1", "--expected-id", "id:", "--expected-current-rev", "r2", "--expected-account", "A"],
    [`/Videos/${secret}.mov`, "--expected-id", "id:video", "--expected-current-rev", "r2", "--expected-account", "A"],
    ["rev:", "--expected-id", "id:video", "--expected-current-rev", "r2", "--expected-account", "A"],
    ["rev:r1", "--expected-id", "id:video", "--expected-account", "A"],
    ["rev:r1", "--expected-id", "id:video", "--expected-current-rev", "r2", "--expected-hash", secret, "--expected-account", "A"],
  ];
  for (const argv of cases) {
    const out = await run(argv);
    expect(out.exit).not.toBe(0);
    expect(out.result.error.code).toBe("invalid_args");
    expect(out.stdout).not.toContain(secret);
  }
  expect(calls()).toEqual([]);
});

test("a throttled link request is retried as a read", async () => {
  const out = await run(args, `let throttled = false; const minted = temporary; temporary = () => { if (throttled) return minted(); throttled = true; return new Response('{}', {status:429}); };`);
  expect(out.exit).toBe(0);
  expect(out.result.data.link).toBe(link);
  expect(calls()).toEqual([metadataCall, linkCall, linkCall]);
});

test("a lost link request is a connection error, not an unknown mutation outcome", async () => {
  const out = await run(args, `temporary = () => { throw new TypeError('socket closed'); };`);
  expect(out.exit).not.toBe(0);
  expect(out.result.error.code).toBe("connection_error");
});

test("a link request that never answers is cancelled at the deadline", async () => {
  const out = await run([...args, "--timeout", "1"], `temporary = () => new Promise(() => {});`);
  expect(out.exit).not.toBe(0);
  expect(out.result.error.code).toBe("cancelled");
});
