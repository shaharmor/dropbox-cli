import { test, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { fixture } from "./auth-fixture";
setDefaultTimeout(60000);
let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(async () => { await f.close(); });

test("config/auth missing, round-trip, status and clear remain compatible", async () => {
  expect(await f.run(`
    assert.equal(config.readConfig(),null); assert.equal(config.readAuth(),null);
    config.writeConfig(app); assert.deepEqual(config.readConfig(),app);
    config.writeAuth(fake); assert.deepEqual(config.readAuth(),fake);
    assert.deepEqual(auth.getStatus(),{logged_in:true,account_email:fake.account_email,account_id:'A',token_expires_at:fake.expires_at,client_id:app.client_id});
    auth.logout(); assert.equal(config.readAuth(),null); auth.logout();
    assert.deepEqual(auth.getStatus(),{logged_in:false});
  `)).toMatchObject({ exit: 0 });
});

test("credential files and coordination database are owner-only", async () => {
  expect(await f.run(`
    const { statSync, readdirSync } = await import('node:fs');
    config.writeConfig(app); config.writeAuth(fake);
    const dir=process.env.DROPBOX_CLI_CONFIG_DIR;
    assert.equal(statSync(dir).mode & 0o777,0o700);
    assert.ok(readdirSync(dir).includes('auth-coordination.sqlite'));
    for(const name of readdirSync(dir)) assert.equal(statSync(join(dir,name)).mode & 0o777,0o600);
  `)).toMatchObject({ exit: 0 });
});

const seedLegacy = `
  const { mkdirSync, chmodSync, statSync, readdirSync }=await import('node:fs');
  const dir=process.env.DROPBOX_CLI_CONFIG_DIR;
  const authPath=join(dir,'auth.json'), appPath=join(dir,'config.json');
  const now=Math.floor(Date.now()/1000), legacy={...fake,expires_at:now+60};
  const legacyBytes=JSON.stringify(legacy,null,2), appBytes=JSON.stringify(app,null,2);
  mkdirSync(dir,{mode:0o755}); chmodSync(dir,0o755);
  writeFileSync(authPath,legacyBytes,{mode:0o644}); chmodSync(authPath,0o644);
  writeFileSync(appPath,appBytes,{mode:0o644}); chmodSync(appPath,0o644);
  assert.equal(statSync(dir).mode & 0o777,0o755);
  for(const path of [authPath,appPath]) assert.equal(statSync(path).mode & 0o777,0o644);
  assert.deepEqual(readdirSync(dir).sort(),['auth.json','config.json']);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(authPath,'utf8')),'generation'),false);
  const assertPrivateStore=()=> {
    assert.equal(statSync(dir).mode & 0o777,0o700);
    const names=readdirSync(dir); assert.ok(names.includes('auth-coordination.sqlite'));
    for(const name of names) assert.equal(statSync(join(dir,name)).mode & 0o777,0o600,name);
  };
`;

test("near-expiry legacy JSON migrates through refresh, preserves the account and fences legacy writers", async () => {
  expect(await f.run(`${seedLegacy}
    let calls=0;
    globalThis.fetch=async(url,options)=> {
      calls++; assert.equal(String(url),'https://api.dropboxapi.com/oauth2/token');
      assert.equal(options.method,'POST'); assert.ok(options.signal);
      assert.equal(new Headers(options.headers).get('Content-Type'),'application/x-www-form-urlencoded');
      assert.deepEqual(Object.fromEntries(new URLSearchParams(options.body)),{
        grant_type:'refresh_token',refresh_token:legacy.refresh_token,...app,
      });
      assert.equal(readFileSync(authPath,'utf8'),legacyBytes);
      assert.equal(readFileSync(appPath,'utf8'),appBytes);
      assertPrivateStore();
      return Response.json({access_token:'fresh-A',expires_in:3600,account_id:'A'});
    };
    const snapshot=await api.getCredentialSnapshot({expectedAccountId:'A'});
    assert.equal(calls,1);
    assert.equal(typeof snapshot.generation,'string'); assert.ok(snapshot.generation);
    assert.ok(!['legacy','absent'].includes(snapshot.generation));
    const {generation,...credentials}=snapshot;
    assert.deepEqual(credentials,{...legacy,access_token:'fresh-A',expires_at:snapshot.expires_at});
    assert.ok(snapshot.expires_at>=now+3600 && snapshot.expires_at<=Math.floor(Date.now()/1000)+3600);
    const migratedBytes=readFileSync(authPath,'utf8');
    assert.deepEqual(JSON.parse(migratedBytes),snapshot);
    assert.equal(readFileSync(appPath,'utf8'),appBytes);
    assertPrivateStore();
    for(const staleWrite of [
      ()=>config.writeAuth({...legacy,account_id:'B',access_token:'stale-B'},'legacy'),
      ()=>config.writeConfig({...app,client_id:'stale-client'},'legacy'),
    ]) {
      assert.throws(staleWrite,e=>e.code==='auth_superseded');
      assert.equal(readFileSync(authPath,'utf8'),migratedBytes);
      assert.equal(readFileSync(appPath,'utf8'),appBytes);
    }
    assert.deepEqual(config.readAuth(),credentials);
    assert.deepEqual(await api.getCredentialSnapshot({expectedAccountId:'A'}),snapshot);
    assert.equal(calls,1);
  `)).toMatchObject({ exit: 0, stderr: "" });
});

for(const failure of ['refused','different-account']) {
  test(`legacy refresh ${failure} leaves original credentials unmigrated and owner-only`, async () => {
    expect(await f.run(`${seedLegacy}
      let calls=0;
      globalThis.fetch=async(url)=> {
        calls++; assert.equal(String(url),'https://api.dropboxapi.com/oauth2/token');
        assert.equal(readFileSync(authPath,'utf8'),legacyBytes);
        assertPrivateStore();
        return ${failure === 'refused'
          ? "Response.json({error:'DO-NOT-LEAK fake-refresh fake-secret'},{status:400})"
          : "Response.json({access_token:'DO-NOT-LEAK',expires_in:3600,account_id:'B'})"};
      };
      await assert.rejects(()=>api.getCredentialSnapshot({expectedAccountId:'A'}),e=>
        e.code==='auth_error' && !['DO-NOT-LEAK',legacy.refresh_token,app.client_secret].some(secret=>e.message.includes(secret)));
      assert.equal(calls,1);
      assert.equal(readFileSync(authPath,'utf8'),legacyBytes);
      assert.equal(readFileSync(appPath,'utf8'),appBytes);
      assertPrivateStore();
      assert.deepEqual(config.readAuth(),legacy);
    `)).toMatchObject({ exit: 0, stderr: "" });
  });
}

test("malformed legacy records fail without secrets", async () => {
  expect(await f.run(`${seedLegacy}
    writeFileSync(authPath,'{"access_token":"DO-NOT-LEAK"');
    assert.throws(()=>config.readAuth(),e=>e.code==='credential_store_error'&&!e.message.includes('DO-NOT-LEAK'));
    writeFileSync(authPath,JSON.stringify({...legacy,expires_at:'bad'}));
    assert.throws(()=>config.readAuth(),e=>e.code==='credential_store_error');
  `)).toMatchObject({ exit: 0 });
});

test("symlink and permission errors fail closed for credentials and SQLite", async () => {
  expect(await f.run(`
    const { chmodSync, symlinkSync, unlinkSync }=await import('node:fs');
    config.writeConfig(app); config.writeAuth(fake);
    const dir=process.env.DROPBOX_CLI_CONFIG_DIR;
    const file=join(dir,'auth.json'); chmodSync(file,0);
    assert.throws(()=>config.readAuth(),e=>e.code==='credential_store_error'); chmodSync(file,0o600);
    unlinkSync(file); writeFileSync(join(root,'untouched'),'sentinel'); symlinkSync(join(root,'untouched'),file);
    assert.throws(()=>config.writeAuth(fake)); assert.equal(readFileSync(join(root,'untouched'),'utf8'),'sentinel');
    unlinkSync(file);
    chmodSync(join(dir,'auth-coordination.sqlite'),0);
    assert.throws(()=>config.writeAuth(fake),e=>e.code==='coordination_error');
  `)).toMatchObject({ exit: 0 });
});

test("generation fences browser completion after logout, another login, cancellation and app changes", async () => {
  expect(await f.run(`
    config.writeConfig(app); config.writeAuth(fake);
    for(const supersede of [()=>auth.logout(),()=>config.beginAuthAttempt(),()=>config.cancelAuthAttempt(generation),()=>config.writeConfig({...app,client_id:'other'})]) {
      var generation=config.beginAuthAttempt(); supersede();
      assert.throws(()=>config.writeAuth(fake,generation),e=>e.code==='auth_superseded');
    }
    const current=config.beginAuthAttempt(); config.writeAuth(fake,current);
    assert.deepEqual(config.readAuth(),fake);
    const newer=config.beginAuthAttempt(); config.cancelAuthAttempt(current);
    config.writeAuth(fake,newer);
  `)).toMatchObject({ exit: 0 });
});
