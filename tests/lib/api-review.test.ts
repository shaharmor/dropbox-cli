import { test, expect, beforeEach, afterEach } from "bun:test";
import { fixture } from "./auth-fixture";

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(async () => { await f.close(); });
const seed = `config.writeConfig(app); config.writeAuth(fake);`;
const virtualTimers = `
  let clock=0; const delays=[];
  Object.defineProperty(performance,'now',{value:()=>clock});
  globalThis.setTimeout=(callback,delay)=>{delays.push(delay);queueMicrotask(()=>{clock+=delay;callback();});return 1;};
  globalThis.clearTimeout=()=>{};
`;

for (const status of [429, 503]) {
  test(`read ${status} honors delta/date provider minimums and timer boundaries`, async () => {
    const fixed = Date.UTC(2030, 0, 1);
    for (const [header, seconds] of [["3600",3600],["0",1],[" 120 ",120],["2147484",2147484],
      [new Date(fixed+7200_000).toUTCString(),7200],[new Date(fixed-1000).toUTCString(),1]] as const) {
      const out = await f.run(`${seed}
        Date.now=()=>${fixed};config.writeAuth({...fake,expires_at:${fixed/1000+3600}});
        ${virtualTimers}
        let calls=0;
        globalThis.fetch=async()=>{calls++;return Response.json({},calls===1?{status:${status},headers:{'Retry-After':${JSON.stringify(header)}}}:{});};
        await api.machineRpc('files/list_folder',{}, {expectedAccountId:'A'});
        assert.equal(calls,2);assert.equal(delays.reduce((a,b)=>a+b,0),${seconds*1000});
        assert.ok(delays.every(d=>d>0&&d<=2147483647));
      `);
      expect(out).toMatchObject({exit:0,stderr:""});
    }
  });
}

test("invalid present Retry-After fails closed without a shorter retry; absent header keeps the bounded retry budget", async () => {
  const invalid = ["", "-1", "+1", "1.5", "1e3", "NaN", "Infinity", "tomorrow", "2030-01-01",
    "Tue, 32 Jan 2030 00:00:00 GMT", "Wed, 01 Jan 2030 00:00:00 GMT", "9".repeat(100), "9007199254740991", "0".repeat(129)];
  const out = await f.run(`${seed}${virtualTimers}
    for(const status of [429,503]) {
      for(const header of [...${JSON.stringify(invalid)},String(Math.floor((Number.MAX_SAFE_INTEGER-Date.now())/1000)+1)]) {
        let calls=0;delays.length=0;
        globalThis.fetch=async()=>{calls++;return Response.json({error:{'.tag':'unavailable'}},{status,headers:{'Retry-After':header}});};
        await assert.rejects(()=>api.machineRpc('files/list_folder',{}, {expectedAccountId:'A'}),error=>{
          assert.equal(error.details.http_status,status);assert.equal(error.details.retry_after_seconds,undefined);return true;
        });
        assert.equal(calls,1,header);assert.equal(delays.length,0);
      }
      let calls=0;delays.length=0;
      globalThis.fetch=async()=>{calls++;return Response.json({error:{'.tag':'unavailable'}},{status});};
      await assert.rejects(()=>api.machineRpc('files/list_folder',{}, {expectedAccountId:'A'}));
      assert.equal(calls,6);assert.deepEqual(delays,status===429?[1000,1000,1000,1000,1000]:[1000,2000,4000,8000,16000]);
    }
  `);
  expect(out).toMatchObject({exit:0,stderr:""});
});

test("valid provider timing never shortens the local backoff on later server failures", async () => {
  const out=await f.run(`${seed}${virtualTimers}
    let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({error:{'.tag':'unavailable'}},{status:503,headers:{'Retry-After':'3'}});};
    await assert.rejects(()=>api.machineRpc('files/list_folder',{}, {expectedAccountId:'A'}));
    assert.equal(calls,6);assert.deepEqual(delays,[3000,3000,4000,8000,16000]);
  `);
  expect(out).toMatchObject({exit:0,stderr:""});
});

test("aborting long or maximal safe provider waits retains HTTP/timing evidence without redispatch", async () => {
  const out = await f.run(`${seed}
    const fixed=Date.UTC(2030,0,1);Date.now=()=>fixed;config.writeAuth({...fake,expires_at:fixed/1000+3600});
    const maximum=Math.floor((Number.MAX_SAFE_INTEGER-fixed)/1000);
    for(const status of [429,503]) for(const seconds of [5,3600,2147484,maximum]) {
      const controller=new AbortController();let calls=0;
      globalThis.fetch=async()=>{calls++;return Response.json({}, {status,headers:{'Retry-After':String(seconds)}});};
      const timer=setTimeout(()=>controller.abort(),75);
      const started=performance.now();
      await assert.rejects(()=>api.machineRpc('files/list_folder',{}, {expectedAccountId:'A',signal:controller.signal}),error=>{
        assert.equal(error.code,'cancelled');assert.deepEqual(error.details,{outcome:'not_submitted',http_status:status,retry_after_seconds:seconds});return true;
      });
      clearTimeout(timer);assert.equal(calls,1);assert.ok(performance.now()-started<1000);
    }
  `);
  expect(out).toMatchObject({exit:0,stderr:""});
});

test("refresh deadlines cannot outlive the supported owner's bound", async () => {
  const out=await f.run(`${seed}config.writeAuth({...fake,expires_at:1});let calls=0;
    globalThis.fetch=async()=>{calls++;return Response.json({access_token:'fresh-A',expires_in:3600});};
    for(const refreshTimeoutMs of [15001,Infinity,NaN,0,-1]) {
      await assert.rejects(()=>api.getCredentialSnapshot({expectedAccountId:'A',refreshTimeoutMs}),e=>e.code==='auth_timeout');
    }
    assert.equal(calls,0);assert.equal(config.readAuth().access_token,'fake-A');
  `);
  expect(out).toMatchObject({exit:0,stderr:""});
});

test("a first structured read 401 retains original endpoint evidence when auth recovery is refused", async () => {
  const out=await f.run(`${seed}
    for(const download of [false,true]) {
      config.writeAuth(fake);let reads=0,refreshes=0;
      globalThis.fetch=async(url)=>{
        if(String(url).endsWith('/oauth2/token')){refreshes++;return Response.json({error:{'.tag':'token_endpoint_error'}},{status:401,headers:{'x-dropbox-request-id':'token-endpoint'}});}
        reads++;return Response.json({error:{'.tag':'invalid_access_token',nested:{'.tag':'expired',echo:'fake-A fake-refresh'}}},{status:401,headers:{'x-dropbox-request-id':'original-read'}});
      };
      await assert.rejects(()=>download?api.machineDownload('rev:fake',{expectedAccountId:'A'}):api.machineRpc('files/list_folder',{}, {expectedAccountId:'A'}),e=>{
        assert.equal(e.code,'auth_error');assert.equal(e.message,'Dropbox authentication was refused. Reconnect the account.');
        assert.deepEqual(e.details,{outcome:'not_submitted',http_status:401,retry_after_seconds:undefined,request_id:'original-read',
          dropbox:{'.tag':'invalid_access_token',nested:{'.tag':'expired',echo:'[REDACTED] [REDACTED]'}}});return true;
      });
      assert.equal(reads,1);assert.equal(refreshes,1);
    }
  `);
  expect(out).toMatchObject({exit:0,stderr:""});
});

test("optional first-401 diagnostics never block successful read recovery on malformed or stalled bodies", async () => {
  const out=await f.run(`${seed}
    const watchdog=setTimeout(()=>process.exit(99),4000);
    for(const body of ['structured','malformed','stalled']) {
      config.writeAuth(fake);let reads=0,refreshes=0;
      globalThis.fetch=async(url)=>{
        if(String(url).endsWith('/oauth2/token')){refreshes++;return Response.json({access_token:'fresh-A',expires_in:3600});}
        if(++reads===2)return Response.json({recovered:true});
        if(body==='structured')return Response.json({error:{'.tag':'invalid_access_token'}},{status:401});
        return new Response(body==='malformed'?'{broken':new ReadableStream({pull(){},cancel(){return new Promise(()=>{});}}),{status:401});
      };
      assert.deepEqual(await api.machineRpc('files/list_folder',{}, {expectedAccountId:'A'}),{recovered:true});
      assert.equal(reads,2);assert.equal(refreshes,1);
    }
    clearTimeout(watchdog);
  `);
  expect(out).toMatchObject({exit:0,stderr:""});
}, 10000);

test("original read-401 evidence never overrides account mismatch or request cancellation", async () => {
  const out=await f.run(`${seed}
    let calls=0;
    globalThis.fetch=async()=>{calls++;config.writeAuth({...fake,account_id:'B',access_token:'fake-B'});return Response.json({error:{'.tag':'invalid_access_token'}},{status:401});};
    await assert.rejects(()=>api.machineRpc('files/list_folder',{}, {expectedAccountId:'A'}),e=>e.code==='account_mismatch');assert.equal(calls,1);
    config.writeAuth(fake);calls=0;const controller=new AbortController();
    globalThis.fetch=async()=>{calls++;return new Response(new ReadableStream({pull(){},cancel(){return new Promise(()=>{});}}),{status:401});};
    const watchdog=setTimeout(()=>process.exit(99),2000);setTimeout(()=>controller.abort(),75);
    await assert.rejects(()=>api.machineRpc('files/list_folder',{}, {expectedAccountId:'A',signal:controller.signal}),e=>e.code==='cancelled');
    clearTimeout(watchdog);assert.equal(calls,1);
  `);
  expect(out).toMatchObject({exit:0,stderr:""});
},5000);

test("structured read and mutation 401 use auth_error with sanitized bounded details and no mutation recovery", async () => {
  const out = await f.run(`${seed}
    for(const mutation of [false,true]) {
      config.writeAuth(fake);
      let calls=0,refreshes=0;
      globalThis.fetch=async(url)=>{
        if(String(url).endsWith('/oauth2/token')){refreshes++;return Response.json({access_token:'fresh-A',expires_in:3600});}
        calls++;return Response.json({error:{'.tag':'invalid_access_token',nested:{'.tag':'expired',echo:'fake-A fake-refresh fresh-A',secret:'never-echo'}},error_summary:'unsafe reconnect URL fake-A'},
          {status:401,headers:{'x-dropbox-request-id':'req-401 fake-A '+ 'x'.repeat(500)}});
      };
      await assert.rejects(()=>api.machineRpc(mutation?'files/move_v2':'files/list_folder',{}, {expectedAccountId:'A'}),error=>{
        assert.equal(error.code,'auth_error');assert.equal(error.message,'Dropbox authentication was refused. Reconnect the account.');
        assert.equal(error.details.outcome,mutation?'refused':'not_submitted');assert.equal(error.details.http_status,401);
        assert.equal(error.details.dropbox['.tag'],'invalid_access_token');assert.equal(error.details.dropbox.nested['.tag'],'expired');
        assert.ok(error.details.request_id.startsWith('req-401 [REDACTED]'));assert.ok(error.details.request_id.length<=256);
        assert.ok(!JSON.stringify(error).includes('fake-A'));assert.ok(!JSON.stringify(error).includes('fake-refresh'));assert.ok(!JSON.stringify(error).includes('never-echo'));
        return true;
      });
      assert.equal(calls,mutation?1:2);assert.equal(refreshes,mutation?0:1);
    }
  `);
  expect(out).toMatchObject({exit:0,stderr:""});
});
