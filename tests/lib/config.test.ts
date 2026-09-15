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

test("legacy JSON migrates without losing credentials; malformed records fail without secrets", async () => {
  expect(await f.run(`
    const { mkdirSync, chmodSync }=await import('node:fs');
    const dir=process.env.DROPBOX_CLI_CONFIG_DIR; mkdirSync(dir,{mode:0o700});
    writeFileSync(join(dir,'auth.json'),JSON.stringify(fake),{mode:0o600});
    assert.deepEqual(config.readAuth(),fake);
    config.writeConfig(app); config.writeAuth(fake);
    writeFileSync(join(dir,'auth.json'),'{"access_token":"DO-NOT-LEAK"');
    assert.throws(()=>config.readAuth(),e=>e.code==='credential_store_error'&&!e.message.includes('DO-NOT-LEAK'));
    writeFileSync(join(dir,'auth.json'),JSON.stringify({...fake,expires_at:'bad'}));
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
