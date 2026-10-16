import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { pathToFileURL } from "url";
import { fixture } from "../lib/auth-fixture";

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(async () => { await f.close(); });
const entry = pathToFileURL(join(import.meta.dir, "../../src/index.ts")).href;
const photos = Array.from({ length: 25 }, (_, i) => ({ fileID: `id:${i}`, revision: `abcdef123${i}`, contentHash: "a".repeat(64) }));
const setup = `config.writeConfig(app); config.writeAuth(fake);
  globalThis.fetch=async(url,init)=>{
    assert.equal(String(url),'https://content.dropboxapi.com/2/files/get_thumbnail_batch');
    assert.equal(new Headers(init.headers).get('Authorization'),'Bearer fake-A');
    const body=JSON.parse(init.body);
    assert.equal(body.entries.length,25);
    for(const e of body.entries) { assert.equal(e.size,'w256h256'); assert.equal(e.format,'jpeg'); assert.equal(e.mode,'strict'); assert.ok(e.path.startsWith('rev:')); }
    return Response.json({entries:body.entries.map((e,i)=>({'.tag':'success',metadata:{'.tag':'file',id:'id:'+i,rev:e.path.slice(4),content_hash:'a'.repeat(64)},thumbnail:'aGVsbG8='}))});
  };`;
async function run(input: unknown = photos, script = setup, flags: string[] = []) {
  const out = await f.run(`${script}\nprocess.argv=['bun','dropbox-cli','thumbnails','--expected-account','A',...${JSON.stringify(flags)}];await import(${JSON.stringify(entry)});`, JSON.stringify(input));
  return { ...out, result: JSON.parse(out.stdout) };
}

test("25 revision-pinned thumbnails use one content-host RPC and no originals", async () => {
  const out = await run();
  expect(out.exit).toBe(0);
  expect(out.result.data.entries).toHaveLength(25);
  expect(out.result.data.entries[0]).toEqual({ fileID: 'id:0', revision: photos[0]!.revision, thumbnail: 'aGVsbG8=' });
});

test("thumbnail batches reject invalid bounds and identities before dispatch", async () => {
  for (const input of [[], [...photos, photos[0]], [photos[0], photos[0]], [{ fileID: 'id:', revision: 'r' }], [{ ...photos[0], contentHash: 'wrong' }]]) {
    const out = await run(input, `config.writeConfig(app);config.writeAuth(fake);`);
    expect(out.exit).not.toBe(0); expect(out.result.error.code).toBe('invalid_args');
  }
});

test("unsupported photos are per-entry failures; mismatched identity never returns pixels", async () => {
  for (const change of ["entries[1]={'.tag':'failure',failure:{'.tag':'unsupported_image'}};", "entries[1].metadata.id='id:wrong';", "entries[1].metadata.rev='other';", "entries[1].metadata.content_hash='b'.repeat(64);", "entries[1].thumbnail='!bad';", "entries[1].thumbnail=Buffer.alloc(65537).toString('base64');"]) {
    const script = setup + `const originalFetch=globalThis.fetch;globalThis.fetch=async(url,init)=>{const {entries}=await (await originalFetch(url,init)).json();${change}return Response.json({entries});};`;
    const out = await run(photos, script);
    expect(out.exit).toBe(0); expect(out.result.data.entries[0].thumbnail).toBe('aGVsbG8=');
    expect(out.result.data.entries[1]).toEqual({fileID:'id:1',revision:photos[1]!.revision,error:'unavailable'});
  }
});

test("malformed batch, account mismatch, cancellation and response bound fail closed", async () => {
  for (const response of ["Response.json({entries:[]})", "new Response('x'.repeat(4*1024*1024+1))", "new Promise(()=>{})"]) {
    const out = await run(photos, `config.writeConfig(app);config.writeAuth(fake);globalThis.fetch=async()=>${response};`, ['--timeout','1']);
    expect(out.exit).not.toBe(0); expect(out.result.ok).toBe(false);
    expect(out.stdout).not.toContain('fake-A');
  }
  const out = await run(photos, setup, ['--expected-account','B']);
  expect(out.result.error.code).toBe('account_mismatch');
});
