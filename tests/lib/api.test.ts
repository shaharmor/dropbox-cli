import { test, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { fixture } from "./auth-fixture";
setDefaultTimeout(60000);
let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(async () => { await f.close(); });
const seed = `config.writeConfig(app); config.writeAuth(fake);`;

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
    const result=await f.run(`${seed} config.writeAuth({...fake,expires_at:1}); const opts={expectedAccountId:'B'}; globalThis.fetch=async()=>{console.error('DISPATCHED');return Response.json({});}; await ${call};`);
    expect(result.exit).not.toBe(0); expect(result.stdout).toContain('account_mismatch'); expect(result.stderr).not.toContain('DISPATCHED');
  }
}, 20000);

test("an in-flight A result remains A after account changes; no credential lock spans content", async () => {
  expect(await f.run(`${seed}
    globalThis.fetch=async(url,options)=> { assert.equal(new Headers(options.headers).get('Authorization'),'Bearer fake-A'); config.writeAuth({...fake,account_id:'B',access_token:'fake-B'}); return Response.json({account:'A'}); };
    assert.deepEqual(await api.rpc('files/list_folder',{}, {expectedAccountId:'A'}),{account:'A'});
    assert.equal(config.readAuth().account_id,'B');
  `)).toMatchObject({ exit: 0 });
});

test("401 recovery cannot retarget from A to B or resurrect logout", async () => {
  for(const change of ["config.writeAuth({...fake,account_id:'B',access_token:'fake-B'})","auth.logout()"]){
    const result=await f.run(`${seed} let calls=0; globalThis.fetch=async()=> { calls++; if(calls>1) console.error('RETARGETED'); ${change}; return new Response('',{status:401}); }; await api.rpc('files/list_folder',{}, {expectedAccountId:'A'});`);
    expect(result.exit).not.toBe(0); expect(result.stderr).not.toContain('RETARGETED'); expect(result.stdout).toContain(change.includes('logout')?'auth_error':'account_mismatch');
  }
}, 20000);

test("near-expiry and 401 refresh use a new immutable same-account snapshot", async () => {
  expect(await f.run(`${seed}
    config.writeAuth({...fake,expires_at:1}); let refreshes=0, content=0;
    globalThis.fetch=async(url,options)=> { if(String(url).endsWith('/oauth2/token')) { refreshes++; assert.ok(options.signal); return Response.json({access_token:'fresh-'+refreshes,expires_in:3600}); } content++; assert.equal(new Headers(options.headers).get('Authorization'),'Bearer fresh-'+refreshes); return Response.json({ok:true}); };
    await api.rpc('files/list_folder'); assert.equal(refreshes,1);
    globalThis.fetch=async(url,options)=> { if(String(url).endsWith('/oauth2/token')) { refreshes++; return Response.json({access_token:'fresh-'+refreshes,expires_in:3600}); } content++; return content===2 ? new Response('',{status:401}) : Response.json({ok:true}); };
    await api.rpc('files/list_folder'); assert.equal(refreshes,2); assert.equal(content,3);
  `)).toMatchObject({ exit: 0 });
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
}, 30000);

test("missing credentials and failed refresh produce noninteractive sanitized errors", async () => {
  const missing=await f.run(`await api.rpc('files/list_folder');`);
  expect(missing.stdout).toContain('auth_error'); expect(missing.exit).not.toBe(0);
  const failed=await f.run(`${seed} config.writeAuth({...fake,expires_at:1}); globalThis.fetch=async()=>new Response('DO-NOT-LEAK fake-secret',{status:400}); await api.rpc('files/list_folder');`);
  expect(failed.stdout).toContain('auth_error'); expect(failed.stdout+failed.stderr).not.toContain('DO-NOT-LEAK');
});

test("refresh deadline cancels stuck network and releases coordination", async () => {
  expect(await f.run(`${seed} config.writeAuth({...fake,expires_at:1});
    globalThis.fetch=async()=>new Promise(()=>{});
    await assert.rejects(()=>api.getCredentialSnapshot({expectedAccountId:'A',refreshTimeoutMs:50}),e=>e.code==='auth_timeout');
    auth.logout(); assert.equal(config.readAuth(),null);
  `)).toMatchObject({exit:0});
});

test("authentication refusals are distinct and API error echoes cannot expose tokens", async () => {
  const refused=await f.run(`${seed} globalThis.fetch=async()=>new Response('{}',{status:401}); await api.rpc('files/move_v2',{}, {retry:'mutation'});`);
  expect(JSON.parse(refused.stdout).error.code).toBe('auth_error');
  const leaked=await f.run(`${seed} globalThis.fetch=async()=>Response.json({error:{'.tag':'fake-A'},error_summary:'Bearer fake-A fake-refresh'},{status:409}); await api.rpc('files/get_metadata');`);
  expect(leaked.stdout).not.toContain('fake-A'); expect(leaked.stdout).not.toContain('fake-refresh');
  expect(await f.run(`${seed} globalThis.fetch=async()=>Response.json({error:{'.tag':'conflict',nested:'fake-A'}},{status:409}); assert.equal((await api.rpcRaw('files/move_v2')).data.error.nested,'[REDACTED]');`)).toMatchObject({exit:0});
});

test("Dropbox API error envelope and batch failure remain structured", async () => {
  const failed=await f.run(`${seed} globalThis.fetch=async()=>Response.json({error:{'.tag':'not_found'},error_summary:'path/not_found/.'},{status:409}); await api.rpc('files/get_metadata');`);
  expect(JSON.parse(failed.stdout).error).toEqual({code:'not_found',message:'path/not_found/.'});
  const batch=await f.run(`${seed} globalThis.fetch=async()=>Response.json({'.tag':'failed'}); await api.pollBatchJob('files/copy_batch/check_v2','fake-job');`);
  expect(batch.stdout).toContain('batch_error');
});
