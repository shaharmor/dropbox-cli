import { test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { fixture } from "../lib/auth-fixture";

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(async () => { await f.close(); });
const entry = pathToFileURL(join(import.meta.dir, "../../src/index.ts")).href;
const entries = Array.from({length: 10}, (_, i) => ({fileID: `id:${i}`, revision: 'r1', size: 3,
  contentHash: 'a'.repeat(64), sourcePath: `/Photos/${i}.jpg`, destinationPath: `/Photos/deleted/${i}.jpg`,
  sourceParentID: 'id:photos', destinationParentID: 'id:deleted'}));
const setup = `
config.writeConfig(app);config.writeAuth(fake);
const entries=${JSON.stringify(entries)};
const photo=e=>({'.tag':'file',id:e.fileID,name:e.sourcePath.split('/').at(-1),rev:'r1',size:3,content_hash:e.contentHash,path_lower:e.sourcePath.toLowerCase(),path_display:e.sourcePath});
const moved=e=>({...photo(e),rev:'r2',path_lower:e.destinationPath.toLowerCase(),path_display:e.destinationPath});
const folder=(id,path)=>({'.tag':'folder',id,name:path.split('/').at(-1),path_lower:path.toLowerCase(),path_display:path});
const absent=()=>Response.json({error:{'.tag':'path',path:{'.tag':'not_found'}}},{status:409});
const respond=async(url,init)=>{
 const endpoint=String(url).split('/2/')[1], body=JSON.parse(init.body||'{}');
 appendFileSync(join(root,'requests'),JSON.stringify({endpoint,body})+'\\n');
 if(endpoint==='files/get_metadata') {
  if(body.path==='/photos')return Response.json(folder('id:photos','/Photos'));
  if(body.path==='/photos/deleted')return Response.json(folder('id:deleted','/Photos/deleted'));
  const e=entries.find(e=>e.fileID===body.path);if(e)return Response.json(photo(e));
  return absent();
 }
 if(endpoint==='files/move_batch_v2')return Response.json({'.tag':'complete',entries:body.entries.map(b=>({'.tag':'success',success:moved(entries.find(e=>e.fileID===b.from_path))}))});
 throw new Error('Denied endpoint');
};globalThis.fetch=respond;
`;
async function cli(input: unknown = entries, extra = '', flags: string[] = []) {
  return f.run(setup + extra + `\nprocess.argv=['bun','dropbox-cli','mv-batch','--expected-account','A',...${JSON.stringify(flags)}];await import(${JSON.stringify(entry)});`, JSON.stringify(input));
}
function calls() { return existsSync(join(f.root,'requests')) ? readFileSync(join(f.root,'requests'),'utf8').trim().split('\n').map(s=>JSON.parse(s)) : []; }
function data(out: {stdout: string}) { return JSON.parse(out.stdout).data; }

test('safe batch shares parent checks and submits ten ID-addressed moves in one request', async () => {
  const out = await cli();
  expect(out.exit).toBe(0);
  expect(data(out).entries).toHaveLength(10);
  expect(data(out).entries.every(e=>e.outcome==='confirmed' && e.metadata.rev==='r2')).toBe(true);
  const requests=calls();
  expect(requests).toHaveLength(23);
  expect(requests.filter(c=>c.endpoint==='files/move_batch_v2')).toEqual([{endpoint:'files/move_batch_v2',body:{entries:entries.map(e=>({from_path:e.fileID,to_path:e.destinationPath})),autorename:false,allow_ownership_transfer:false}}]);
});

test('invalid, empty, oversized and overlapping batches never dispatch', async () => {
  for(const input of [[], Array(101).fill(entries[0]), [entries[0],entries[0]], [{...entries[0],fileID:'/Photos/0.jpg'}],
    [{...entries[0],contentHash:'invalid'}], [{...entries[0],sourcePath:'/Photos/../0.jpg'}],
    [{...entries[0],sourcePath:'/'+'x'.repeat(512*1024)}],
    [entries[0],{...entries[1],destinationPath:entries[0].sourcePath}]]) {
    const out=await cli(input);expect(out.exit).not.toBe(0);expect(JSON.parse(out.stdout).error.details.outcome).toBe('not_submitted');
  }
  expect(calls()).toEqual([]);
});

test('per-photo drift blocks only that photo, and results retain original input order', async () => {
  const out=await cli(entries, `globalThis.fetch=async(url,init)=>JSON.parse(init.body||'{}').path==='id:3'?Response.json({...photo(entries[3]),rev:'changed'}):respond(url,init);`);
  expect(data(out).entries.map(e=>e.fileID)).toEqual(entries.map(e=>e.fileID));
  expect(data(out).entries[3].outcome).toBe('not_submitted');
  expect(data(out).entries.filter(e=>e.outcome==='confirmed')).toHaveLength(9);
  expect(calls().find(c=>c.endpoint==='files/move_batch_v2').body.entries).toHaveLength(9);
});

test('async receipt can be polled without repeating preflight or submitting again', async () => {
  const launch=await cli(entries, `globalThis.fetch=async(url,init)=>String(url).endsWith('/move_batch_v2')?Response.json({'.tag':'async_job_id',async_job_id:'job-1'}):respond(url,init);`);
  expect(data(launch).async_job_id).toBe('job-1');
  expect(data(launch).entries.every(e=>e.outcome==='pending')).toBe(true);
  for(const complete of [false,true]) {
    const out=await cli(entries, `globalThis.fetch=async(url,init)=>{assert.equal(String(url).endsWith('/move_batch/check_v2'),true);assert.deepEqual(JSON.parse(init.body),{async_job_id:'job-1'});return Response.json(${complete ? "{'.tag':'complete',entries:entries.map(e=>({'.tag':'success',success:moved(e)}))}" : "{'.tag':'in_progress'}"});};`, ['--job-id','job-1']);
    expect(out.exit).toBe(0);expect(data(out).entries.every(e=>e.outcome===(complete?'confirmed':'pending'))).toBe(true);
  }
});

test('partial provider failures distinguish refusal from uncertain internal errors', async () => {
  const out=await cli(entries.slice(0,3), `globalThis.fetch=async(url,init)=>String(url).endsWith('/move_batch_v2')?Response.json({'.tag':'complete',entries:[{'.tag':'success',success:moved(entries[0])},{'.tag':'failure',failure:{'.tag':'relocation_error',relocation_error:{'.tag':'to',to:{'.tag':'conflict'}}}},{'.tag':'failure',failure:{'.tag':'internal_error'}}]}):respond(url,init);`);
  expect(data(out).entries.map(e=>e.outcome)).toEqual(['confirmed','refused','unknown']);
});

test('malformed results and lost acknowledgments stay unknown and never replay', async () => {
  for(const fault of ["throw new Error('lost');", "return Response.json({'.tag':'complete',entries:[]});", "return Response.json({'.tag':'complete',entries:[{'.tag':'success',success:{...moved(entries[0]),id:'id:wrong'}}]});"]) {
    const out=await cli(entries.slice(0,1), `globalThis.fetch=async(url,init)=>{if(String(url).endsWith('/move_batch_v2')){appendFileSync(join(root,'mutations'),'once\\n');${fault}}return respond(url,init);};`);
    expect(data(out).entries[0].outcome).toBe('unknown');
  }
  expect(readFileSync(join(f.root,'mutations'),'utf8').trim().split('\n')).toHaveLength(3);
});

test('poll failures never claim that the original move was not submitted', async () => {
  const out=await cli(entries.slice(0,1), `globalThis.fetch=async()=>Response.json({error:{'.tag':'invalid_async_job_id'}},{status:409});`, ['--job-id','expired']);
  expect(data(out).entries[0].outcome).toBe('unknown');
  expect(data(out).async_job_id).toBeUndefined();
});

test('account and folder drift stop the entire batch before mutation', async () => {
  for(const extra of ["config.writeAuth({...fake,account_id:'different'});",
    "globalThis.fetch=async(url,init)=>JSON.parse(init.body||'{}').path==='/photos/deleted'?Response.json(folder('id:replacement','/Photos/deleted')):respond(url,init);"]) {
    const out=await cli(entries,extra);expect(out.exit).not.toBe(0);
    expect(JSON.parse(out.stdout).error.details.outcome).toBe('not_submitted');
  }
  expect(calls().some(c=>c.endpoint==='files/move_batch_v2')).toBe(false);
});

test('batch rate limit retains provider timing and never retries a mutation', async () => {
  const out=await cli(entries, `globalThis.fetch=async(url,init)=>{if(String(url).endsWith('/move_batch_v2')){appendFileSync(join(root,'mutations'),'once\\n');return Response.json({error:{'.tag':'too_many_requests'}},{status:429,headers:{'Retry-After':'60'}});}return respond(url,init);};`);
  expect(data(out).entries.every(e=>e.outcome==='unknown' && e.error.details.retry_after_seconds===60)).toBe(true);
  expect(readFileSync(join(f.root,'mutations'),'utf8')).toBe('once\n');
});

test('batch preflight is bounded concurrent work at 100ms simulated Dropbox latency', async () => {
  const start=performance.now();
  const out=await cli(entries, `let active=0,maxActive=0;globalThis.fetch=async(url,init)=>{
    active++;maxActive=Math.max(active,maxActive);await Bun.sleep(100);
    try{return await respond(url,init);}finally{active--;writeFileSync(join(root,'concurrency'),String(maxActive));}
  };`);
  const seconds=(performance.now()-start)/1000;
  expect(out.exit).toBe(0);expect(calls()).toHaveLength(23);
  expect(Number(readFileSync(join(f.root,'concurrency'),'utf8'))).toBe(4);
  console.log(`SAFE_BATCH_BASELINE photos=10 requests=23 helperProcesses=1 latencyMs=100 elapsedSeconds=${seconds.toFixed(3)}`);
  expect(seconds).toBeLessThan(5);
});
