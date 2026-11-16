import { test, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { fixture, PROCESS_TEST_TIMEOUT_MS } from "./auth-fixture";
setDefaultTimeout(PROCESS_TEST_TIMEOUT_MS);
let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(async () => { await f.close(); });
const seed = `config.writeConfig(app); config.writeAuth(fake);`;
// Worker-side predicate: the call rejected with a CommandError carrying this code and exit code.
const commandError = (code: string, exitCode: number) => `e=>e.name==='CommandError'&&e.code==='${code}'&&e.exitCode===${exitCode}`;

test("RPC/raw/upload/download and batch polling keep their success contracts", async () => {
  expect(await f.run(`${seed}
    let calls=[];
    globalThis.fetch=async(url,options)=> { calls.push([url,options]); return new Response('{"ok":true,".tag":"complete"}',{headers:{'Dropbox-API-Result':'{"id":"id:fake"}'}}); };
    assert.equal((await api.rpc('files/list_folder')).ok,true);
    assert.equal(calls[0][1].body,'{}');
    assert.equal(new Headers(calls[0][1].headers).get('Authorization'),'Bearer fake-A');
    assert.equal(new Headers(calls[0][1].headers).get('Content-Type'),'application/json');
    assert.equal((await api.rpcRaw('sharing/create_shared_link')).status,200);
    assert.equal((await api.contentUpload('files/upload',{path:'/fake'},new Uint8Array([1]))).ok,true);
    assert.equal(new Headers(calls[2][1].headers).get('Dropbox-API-Arg'),'{"path":"/fake"}');
    const result=await api.contentDownload('files/download',{path:'rev:fake'},{expectedAccountId:'A'});
    assert.equal(result.metadata.id,'id:fake'); assert.ok(result.body);
    assert.ok(String(calls[3][0]).startsWith('https://content.dropboxapi.com/2/'));
    assert.equal((await api.pollBatchJob('files/copy_batch/check_v2','fake-job'))['.tag'],'complete');
    globalThis.fetch=async()=>Response.json({error:{'.tag':'conflict'}},{status:409});
    assert.equal((await api.rpcRaw('files/move_v2')).ok,false);
  `)).toMatchObject({ exit: 0 });
});

test("expected account mismatch blocks all transport variants before even refreshing", async () => {
  for (const call of ["api.rpc('files/list_folder',{},opts)","api.rpcRaw('files/move_v2',{},opts)","api.contentDownload('files/download',{},opts)","api.contentUpload('files/upload',{},new Uint8Array(),opts)"]) {
    const result=await f.run(`${seed} config.writeAuth({...fake,expires_at:1}); const opts={expectedAccountId:'B'}; globalThis.fetch=async()=>{console.error('DISPATCHED');return Response.json({});}; await assert.rejects(()=>${call},${commandError('account_mismatch',2)});`);
    expect(result).toMatchObject({exit:0,stderr:""});
  }
});

test("an in-flight A result remains A after account changes; no credential lock spans content", async () => {
  expect(await f.run(`${seed}
    globalThis.fetch=async(url,options)=> { assert.equal(new Headers(options.headers).get('Authorization'),'Bearer fake-A'); config.writeAuth({...fake,account_id:'B',access_token:'fake-B'}); return Response.json({account:'A'}); };
    assert.deepEqual(await api.rpc('files/list_folder',{}, {expectedAccountId:'A'}),{account:'A'});
    assert.equal(config.readAuth().account_id,'B');
  `)).toMatchObject({ exit: 0 });
});

test("401 recovery cannot retarget from A to B or resurrect logout", async () => {
  for(const change of ["config.writeAuth({...fake,account_id:'B',access_token:'fake-B'})","auth.logout()"]){
    const code=change.includes('logout')?'auth_error':'account_mismatch';
    const result=await f.run(`${seed} let calls=0; globalThis.fetch=async()=> { calls++; if(calls>1) console.error('RETARGETED'); ${change}; return new Response('',{status:401}); }; await assert.rejects(()=>api.rpc('files/list_folder',{}, {expectedAccountId:'A'}),${commandError(code,2)});`);
    expect(result).toMatchObject({exit:0,stderr:""});
  }
});

test("authentication recovery has a separate budget after a transient read failure", async () => {
  expect(await f.run(`${seed}
    let statuses=[429,401,200],refreshes=0;
    globalThis.fetch=async(url)=> { if(String(url).endsWith('/oauth2/token')) { refreshes++; return Response.json({access_token:'fresh',expires_in:3600}); } return new Response('{}',{status:statuses.shift(),headers:{'Retry-After':'0'}}); };
    await api.rpc('files/list_folder'); assert.equal(refreshes,1); assert.equal(statuses.length,0);
  `)).toMatchObject({ exit: 0 });
});

test("read 500 is retried but mutation 500/429/401 is never redispatched", async () => {
  expect(await f.run(`${seed} let calls=0; globalThis.fetch=async()=>new Response('{}',{status:++calls===1?500:200}); await api.rpc('files/list_folder'); assert.equal(calls,2);`)).toMatchObject({exit:0});
  for(const status of [500,429,401]) {
    expect(await f.run(`${seed} let calls=0; globalThis.fetch=async()=>{calls++; return new Response('{}',{status:${status},headers:{'Retry-After':'0'}});}; const result=await api.rpcRaw('files/move_v2',{}, {expectedAccountId:'A',retry:'mutation'}); assert.equal(result.status,${status}); assert.equal(calls,1);`)).toMatchObject({exit:0});
  }
});

test("missing credentials and failed refresh produce noninteractive sanitized errors", async () => {
  expect(await f.run(`await assert.rejects(()=>api.rpc('files/list_folder'),${commandError('auth_error',2)});`)).toMatchObject({exit:0,stderr:""});
  expect(await f.run(`${seed} config.writeAuth({...fake,expires_at:1}); globalThis.fetch=async()=>new Response('DO-NOT-LEAK fake-secret',{status:400});
    await assert.rejects(()=>api.rpc('files/list_folder'),e=>(${commandError('auth_error',2)})(e) && !e.message.includes('DO-NOT-LEAK'));`)).toMatchObject({exit:0,stderr:""});
});

test("authentication refusals are distinct and API error echoes cannot expose tokens", async () => {
  expect(await f.run(`${seed} globalThis.fetch=async()=>new Response('{}',{status:401}); await assert.rejects(()=>api.rpc('files/move_v2',{}, {retry:'mutation'}),${commandError('auth_error',2)});`)).toMatchObject({exit:0,stderr:""});
  expect(await f.run(`${seed} globalThis.fetch=async()=>Response.json({error:{'.tag':'fake-A'},error_summary:'Bearer fake-A fake-refresh'},{status:409});
    await assert.rejects(()=>api.rpc('files/get_metadata'),e=>e.name==='CommandError' && !/fake-A|fake-refresh/.test(e.code+e.message));`)).toMatchObject({exit:0,stderr:""});
  expect(await f.run(`${seed} globalThis.fetch=async()=>Response.json({error:{'.tag':'conflict',nested:'fake-A'}},{status:409}); assert.equal((await api.rpcRaw('files/move_v2')).data.error.nested,'[REDACTED]');`)).toMatchObject({exit:0});
});

test("Dropbox API error envelope and batch failure remain structured", async () => {
  expect(await f.run(`${seed} globalThis.fetch=async()=>Response.json({error:{'.tag':'not_found'},error_summary:'path/not_found/.'},{status:409});
    await assert.rejects(()=>api.rpc('files/get_metadata'),e=>(${commandError('not_found',1)})(e) && e.message==='path/not_found/.');`)).toMatchObject({exit:0,stderr:""});
  expect(await f.run(`${seed} globalThis.fetch=async()=>Response.json({'.tag':'failed'});
    await assert.rejects(()=>api.pollBatchJob('files/copy_batch/check_v2','fake-job'),e=>(${commandError('batch_error',1)})(e) && e.message==='Batch job failed: failed');`)).toMatchObject({exit:0,stderr:""});
});
