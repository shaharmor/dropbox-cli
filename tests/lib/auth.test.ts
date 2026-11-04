import { test, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { fixture } from "./auth-fixture";
setDefaultTimeout(60000);
let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(async () => { await f.close(); });
const setup = `
  config.writeConfig(app);
  const { get, createServer }=await import('node:http');
  const callback=async(url,params)=> {
    const target=new URL(new URL(url).searchParams.get('redirect_uri')); target.hostname='127.0.0.1';
    target.search=new URLSearchParams(params).toString();
    return new Promise((resolve,reject)=>get(target,res=>{res.resume();res.on('end',()=>resolve(res.statusCode));}).on('error',reject));
  };
  let calls=0;
  globalThis.fetch=async(url,options)=> { calls++; assert.ok(options.signal); return String(url).endsWith('/oauth2/token') ? Response.json({access_token:'fake-A',refresh_token:'fake-refresh',expires_in:3600,account_id:'A'}) : Response.json({account_id:'A',email:'a@example.invalid'}); };
  const options={callbackPort:0,timeoutMs:10000};
`;

test("login preserves PKCE, validates account, and keeps tokens out of result", async () => {
  expect(await f.run(`${setup}
    const result=await auth.login({...options,openBrowser:async url=> {
      const parsed=new URL(url); assert.equal(parsed.searchParams.get('code_challenge_method'),'S256');
      assert.ok(parsed.searchParams.get('code_challenge')); assert.ok(parsed.searchParams.get('state'));
      assert.equal(await callback(url,{state:parsed.searchParams.get('state'),code:'fake-code'}),200);
    }});
    assert.deepEqual(result,{account_id:'A',account_email:'a@example.invalid'}); assert.equal(calls,2); assert.equal(config.readAuth().access_token,'fake-A');
  `)).toMatchObject({exit:0});
});

for (const kind of ['wrong-state','denied','missing-code','cancel','timeout','browser-error']) {
  test(`login ${kind} closes callback resources and exposes no provider secrets`, async () => {
    expect(await f.run(`${setup}
      const controller=new AbortController(); let redirect;
      await assert.rejects(()=>auth.login({...options,timeoutMs:5000,signal:controller.signal,openBrowser:async url=> {
        redirect=new URL(new URL(url).searchParams.get('redirect_uri'));
        const state=new URL(url).searchParams.get('state');
        ${kind === "wrong-state" ? "await callback(url,{state:'wrong-secret',code:'DO-NOT-LEAK'});" : kind === "denied" ? "await callback(url,{state,error:'DO-NOT-LEAK'});" : kind === "missing-code" ? "await callback(url,{state});" : kind === "cancel" ? "controller.abort();" : kind === "browser-error" ? "throw new Error('DO-NOT-LEAK');" : ""}
      }}),e=>e.code==='${({"wrong-state":"auth_state_mismatch",denied:"auth_denied","missing-code":"auth_callback_invalid",cancel:"auth_cancelled",timeout:"auth_timeout","browser-error":"auth_browser_failed"})[kind]}'&&!e.message.includes('DO-NOT-LEAK'));
      assert.equal(calls,0); assert.equal(config.readAuth(),null);
      const server=createServer(); await new Promise((resolve,reject)=>server.once('error',reject).listen(Number(redirect.port),'127.0.0.1',resolve)); await new Promise(resolve=>server.close(resolve));
    `)).toMatchObject({exit:0});
  });
}

test("a stuck browser launcher is terminated at the authentication deadline", async () => {
  expect(await f.run(`${setup}
    let killed=false, finish;
    const child={exitCode:null,exited:new Promise(resolve=>{finish=resolve;}),kill:()=>{killed=true;child.exitCode=1;finish(1);}};
    Bun.spawn=()=>child;
    await assert.rejects(()=>auth.login({...options,timeoutMs:5000}),e=>e.code==='auth_timeout');
    assert.equal(killed,true); assert.equal(config.readAuth(),null);
  `)).toMatchObject({exit:0});
});

test("port conflict fails before launching browser and noninteractive setup never prompts", async () => {
  expect(await f.run(`${setup}
    const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try { await assert.rejects(()=>auth.login({...options,callbackPort:server.address().port,openBrowser:()=>assert.fail('browser launched')}),e=>e.code==='auth_callback_unavailable'); }
    finally { await new Promise(resolve=>server.close(resolve)); }
  `)).toMatchObject({exit:0});
  expect(await f.run(`const {unlinkSync}=await import('node:fs'); unlinkSync(join(process.env.DROPBOX_CLI_CONFIG_DIR,'config.json')); await assert.rejects(()=>auth.login({interactive:false}),e=>e.code==='app_credentials_required');`)).toMatchObject({exit:0});
});

test("logout and a newer login supersede browser completion", async () => {
  for (const change of ["auth.logout()", "config.beginAuthAttempt()"]){
    expect(await f.run(`${setup}
      await assert.rejects(()=>auth.login({...options,openBrowser:async url=> {
        ${change}; await callback(url,{state:new URL(url).searchParams.get('state'),code:'fake-code'});
      }}),e=>e.code==='auth_superseded');
      assert.equal(config.readAuth(),null);
    `)).toMatchObject({exit:0});
  }
}, 20000);

test("token/account failures and deadline do not persist credentials or leak response bodies", async () => {
  for (const mode of ['token','account','identity','timeout']) {
    expect(await f.run(`${setup}
      globalThis.fetch=async url=> {
        if('${mode}'==='timeout') return new Promise(()=>{});
        if('${mode}'==='token'||!String(url).endsWith('/oauth2/token')&&'${mode}'==='account') return new Response('DO-NOT-LEAK',{status:400});
        return String(url).endsWith('/oauth2/token') ? Response.json({access_token:'DO-NOT-LEAK',refresh_token:'fake-refresh',expires_in:3600,account_id:'A'}) : Response.json({account_id:'B',email:'b@example.invalid'});
      };
      await assert.rejects(()=>auth.login({...options,timeoutMs:5000,openBrowser:async url=> {await callback(url,{state:new URL(url).searchParams.get('state'),code:'fake-code'});}}),e=>e.code==='${({token:'auth_exchange_failed',account:'auth_account_failed',identity:'auth_account_failed',timeout:'auth_timeout'})[mode]}'&&!e.message.includes('DO-NOT-LEAK'));
      assert.equal(config.readAuth(),null); auth.logout();
    `)).toMatchObject({exit:0});
  }
}, 30000);
