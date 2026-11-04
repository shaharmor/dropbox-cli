import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fixture } from "./auth-fixture";

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(async () => { await f.close(); });
async function barrier(name: string) {
  const until = Date.now() + 15000;
  while (!existsSync(join(f.root, name))) {
    if (Date.now() > until) throw new Error(`Barrier timed out: ${name}`);
    await Bun.sleep(10);
  }
}
function release(name: string) { writeFileSync(join(f.root, name), "ready"); }
async function seed() {
  expect(await f.run(`config.writeConfig(app); config.writeAuth({...fake, expires_at: 1});`)).toMatchObject({ exit: 0 });
}

describe("credential process coordination", () => {
  test("simultaneous near-expiry download and move share one refresh delayed beyond two seconds", async () => {
    await seed();
    const worker = (kind: string) => f.start(`
      writeFileSync(join(root, '${kind}-ready'), '');
      await waitFor('go');
      globalThis.fetch = async (url, options) => {
        if (String(url).endsWith('/oauth2/token')) {
          appendFileSync(join(root, 'refreshes'), 'refresh\\n');
          await Bun.sleep(2600);
          return Response.json({access_token:'fresh-A',expires_in:3600});
        }
        assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer fresh-A');
        return new Response('{}', {headers:{'Dropbox-API-Result':'{}'}});
      };
      ${kind === "download" ? "await api.contentDownload('files/download',{path:'rev:fake'}, {expectedAccountId:'A'});" : "await api.rpc('files/move_v2',{from_path:'id:fake',to_path:'/deleted/fake'}, {expectedAccountId:'A',retry:'mutation'});"}
      assert.equal(config.readAuth().access_token, 'fresh-A');
    `);
    const a = worker("download"), b = worker("move");
    await Promise.all([barrier("download-ready"), barrier("move-ready")]);
    release("go");
    expect(await a.result()).toMatchObject({ exit: 0 });
    expect(await b.result()).toMatchObject({ exit: 0 });
    expect(readFileSync(join(f.root, "refreshes"), "utf8").trim().split("\n")).toHaveLength(1);
  }, 30000);

  for (const phase of ["before-open", "after-open", "replaced-after-open"] as const) {
    for (const asynchronous of [false, true]) {
      test(`SQLite journal unlink ${phase} is rechecked during ${asynchronous ? "async" : "sync"} acquisition`, async () => {
        await seed();
        const owner = f.start(`
          await config.withCredentialStoreAsync(async store => {
            assert.ok(store.snapshot());
            assert.ok(existsSync(join(process.env.DROPBOX_CLI_CONFIG_DIR,'auth-coordination.sqlite-journal')));
            writeFileSync(join(root,'held'),'');await waitFor('release');
          });
          writeFileSync(join(root,'closed'),'');
        `);
        await barrier("held");
        const result = await f.run(`
          ${asynchronous ? "globalThis.fetch=async()=>Response.json({access_token:'fresh-A',expires_in:3600});" : ""}
          const {mock}=await import('bun:test');const fs=await import('fs');
          const open=fs.openSync,stat=fs.fstatSync;
          const journal=join(process.env.DROPBOX_CLI_CONFIG_DIR,'auth-coordination.sqlite-journal');
          let intercepted=false;
          const releaseOwner=()=>{
            writeFileSync(join(root,'release'),'');const until=Date.now()+5000;
            while(!existsSync(join(root,'closed'))) {
              if(Date.now()>until)throw new Error('Owner did not close');
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
            }
            assert.equal(existsSync(journal),false);
            ${phase === "replaced-after-open" ? "writeFileSync(join(root,'sentinel'),'untouched',{mode:0o600});fs.symlinkSync(join(root,'sentinel'),journal);" : ""}
          };
          mock.module('fs',()=>({...fs,openSync:(path,...args)=>{
            if(String(path)!==journal||intercepted)return open(path,...args);
            intercepted=true;
            ${phase === "before-open" ? "releaseOwner();return open(path,...args);" : "const fd=open(path,...args);releaseOwner();assert.equal(stat(fd).nlink,0);return fd;"}
          }}));
          ${phase === "replaced-after-open"
            ? asynchronous ? "await assert.rejects(()=>api.getCredentialSnapshot({expectedAccountId:'A'}),e=>e.code==='coordination_error');" : "assert.throws(()=>config.readAuth(),e=>e.code==='coordination_error');"
            : asynchronous ? "assert.equal((await api.getCredentialSnapshot({expectedAccountId:'A'})).access_token,'fresh-A');" : "assert.equal(config.readAuth().access_token,'fake-A');"}
          assert.equal(intercepted,true);
          ${phase === "replaced-after-open" ? "assert.equal(readFileSync(join(root,'sentinel'),'utf8'),'untouched');" : ""}
        `);
        expect(result).toMatchObject({exit:0,stderr:""});
        expect(await owner.result()).toMatchObject({exit:0,stderr:""});
      }, 15000);
    }
  }

  test("sidecar lifecycle handling still rejects unsafe files before credential access", async () => {
    await seed();
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      for (const fault of ["symlink", "hardlink", "directory", "permissions", "owner"]) {
        const result=await f.run(`
          const fs=await import('fs');const {mock}=await import('bun:test');
          const dir=process.env.DROPBOX_CLI_CONFIG_DIR;
          const sidecar=join(dir,'auth-coordination.sqlite${suffix}');
          const sentinel=join(root,'sentinel');writeFileSync(sentinel,'untouched',{mode:0o600});
          const original=readFileSync(join(dir,'auth.json'),'utf8');
          ${fault === "symlink" ? "fs.symlinkSync(sentinel,sidecar);" : fault === "hardlink" ? "fs.linkSync(sentinel,sidecar);" : fault === "directory" ? "fs.mkdirSync(sidecar,{mode:0o700});" : `writeFileSync(sidecar,'',{mode:${fault === "permissions" ? "0" : "0o600"}});`}
          ${fault === "owner" ? `const inode=fs.statSync(sidecar).ino;const stat=fs.fstatSync;mock.module('fs',()=>({...fs,fstatSync:fd=>{const value=stat(fd);if(value.ino!==inode)return value;return Object.assign(Object.create(Object.getPrototypeOf(value)),value,{uid:process.getuid()+1});}}));` : ""}
          assert.throws(()=>config.readAuth(),e=>e.code==='coordination_error');
          await assert.rejects(()=>api.getCredentialSnapshot({expectedAccountId:'A'}),e=>e.code==='coordination_error');
          assert.equal(readFileSync(join(dir,'auth.json'),'utf8'),original);
          assert.equal(readFileSync(sentinel,'utf8'),'untouched');
          fs.rmSync(sidecar,{recursive:true});
        `);
        expect(result).toMatchObject({exit:0,stderr:""});
      }
    }
  }, 15000);

  test("unlinked or multiply linked credentials and main database remain fail-closed", async () => {
    for (const name of ["auth.json", "auth-coordination.sqlite"]) {
      for (const unlinked of [false, true]) {
        const result=await f.run(`
          config.writeConfig(app);config.writeAuth(fake);
          const fs=await import('fs');const {mock}=await import('bun:test');const open=fs.openSync;
          const file=join(process.env.DROPBOX_CLI_CONFIG_DIR,'${name}');let inspected=0;
          ${unlinked ? "" : "fs.linkSync(file,join(root,'extra-link'));"}
          mock.module('fs',()=>({...fs,openSync:(path,...args)=>{
            const fd=open(path,...args);
            if(String(path)===file){inspected++;${unlinked ? "fs.unlinkSync(file);" : ""}}
            return fd;
          }}));
          assert.throws(()=>config.readAuth(),e=>e.code==='${name === "auth.json" ? "credential_store_error" : "coordination_error"}');
          assert.equal(inspected,1);
          ${unlinked ? "" : "fs.unlinkSync(join(root,'extra-link'));"}
        `);
        expect(result).toMatchObject({exit:0,stderr:""});
      }
    }
  });

  test("repeated sidecar unlink remains bounded and request-cancellable", async () => {
    await seed();
    const result=await f.run(`
      const fs=await import('fs');const {mock}=await import('bun:test');const open=fs.openSync;
      const journal=join(process.env.DROPBOX_CLI_CONFIG_DIR,'auth-coordination.sqlite-journal');
      writeFileSync(journal,'',{mode:0o600});
      let opens=0;mock.module('fs',()=>({...fs,openSync:(path,...args)=>{
        if(String(path)!==journal)return open(path,...args);
        opens++;writeFileSync(journal,'',{mode:0o600});const fd=open(path,...args);fs.unlinkSync(journal);return fd;
      }}));
      const controller=new AbortController();setTimeout(()=>controller.abort(),75);const started=performance.now();
      await assert.rejects(()=>api.getCredentialSnapshot({expectedAccountId:'A',signal:controller.signal}),e=>e.code==='auth_cancelled');
      assert.ok(performance.now()-started<750);assert.ok(opens>1&&opens<50);
      const before=opens;
      assert.throws(()=>config.readAuth(),e=>e.code==='coordination_timeout');
      assert.ok(opens>before&&opens-before<500);
    `);
    expect(result).toMatchObject({exit:0,stderr:""});
  }, 5000);

  test("a cancelled contender exits promptly without disturbing the live refresh owner", async () => {
    await seed();
    const held = f.start(`globalThis.fetch=async()=> { writeFileSync(join(root,'held'),''); await waitFor('finish');return Response.json({access_token:'fresh-A',expires_in:3600}); }; await api.getCredentialSnapshot({expectedAccountId:'A'});`);
    await barrier("held");
    const contender = await f.run(`
      const controller=new AbortController();let calls=0;
      globalThis.fetch=async()=>{calls++;throw new Error('DISPATCHED');};
      setTimeout(()=>controller.abort(),75);const started=performance.now();
      await assert.rejects(()=>api.getCredentialSnapshot({expectedAccountId:'A',signal:controller.signal}),e=>e.code==='auth_cancelled');
      assert.ok(performance.now()-started<750);assert.equal(calls,0);
    `);
    expect(contender).toMatchObject({exit:0,stderr:""});
    expect(held.child.exitCode).toBeNull();
    release("finish");expect(await held.result()).toMatchObject({exit:0});
    expect(await f.run(`assert.equal(config.readAuth().access_token,'fresh-A');`)).toMatchObject({exit:0});
  }, 15000);

  test("contenders reread logout/account fences after waiting rather than dispatch stale or retargeted credentials", async () => {
    for(const change of ["store.clearAuth()", "store.writeAuth({...fake,account_id:'B',access_token:'fake-B'})"]) {
      await seed();
      const suffix=change.includes('clear')?'logout':'account';
      const held=f.start(`await config.withCredentialStoreAsync(async store=> {writeFileSync(join(root,'held-${suffix}'),'');await waitFor('finish-${suffix}');${change};});`);
      await barrier('held-'+suffix);
      const contender=f.start(`
        writeFileSync(join(root,'waiting-${suffix}'),'');let calls=0;
        globalThis.fetch=async()=>{calls++;throw new Error('DISPATCHED');};
        await assert.rejects(()=>api.machineRpc('files/list_folder',{}, {expectedAccountId:'A'}),e=>e.code==='${suffix==='logout'?'auth_error':'account_mismatch'}');
        assert.equal(calls,0);
      `);
      await barrier('waiting-'+suffix);await Bun.sleep(100);release('finish-'+suffix);
      expect(await held.result()).toMatchObject({exit:0});expect(await contender.result()).toMatchObject({exit:0,stderr:""});
      expect(await f.run(`assert.equal(config.readAuth()?.account_id,${suffix==='logout'?"undefined":"'B'"});`)).toMatchObject({exit:0});
    }
  },15000);

  test("late completion after refresh cancellation cannot publish over logout or replacement account", async () => {
    for(const change of ["auth.logout()", "config.writeAuth({...fake,account_id:'B',access_token:'fake-B'})"]) {
      const out=await f.run(`config.writeConfig(app);config.writeAuth({...fake,expires_at:1});
        let finish;globalThis.fetch=async()=>new Promise(resolve=>{finish=resolve;});
        await assert.rejects(()=>api.getCredentialSnapshot({expectedAccountId:'A',refreshTimeoutMs:50}),e=>e.code==='auth_timeout');
        ${change};const published=readFileSync(join(process.env.DROPBOX_CLI_CONFIG_DIR,'auth.json'),'utf8');
        finish(Response.json({access_token:'stale-A',expires_in:3600}));await Bun.sleep(75);
        assert.equal(readFileSync(join(process.env.DROPBOX_CLI_CONFIG_DIR,'auth.json'),'utf8'),published);
      `);
      expect(out).toMatchObject({exit:0,stderr:""});
    }
  });

  test("uncoordinated readers see complete JSON during credential replacements", async () => {
    await seed();
    const writer = f.start(`await waitFor('go'); for(let i=0;i<60;i++) config.writeAuth({...fake,access_token:'x'.repeat(128000)});`);
    const reader = f.start(`writeFileSync(join(root,'reader-ready'),''); await waitFor('go'); for(let i=0;i<1500;i++) { const value=JSON.parse(readFileSync(join(process.env.DROPBOX_CLI_CONFIG_DIR,'auth.json'),'utf8')); assert.ok(value.access_token); }`);
    await barrier("reader-ready"); release("go");
    expect(await writer.result()).toMatchObject({ exit: 0 });
    expect(await reader.result()).toMatchObject({ exit: 0 });
  }, 120000);

  test("death during refresh releases SQLite ownership without partial credentials", async () => {
    await seed();
    const held = f.start(`globalThis.fetch=async()=> { writeFileSync(join(root,'held'),''); await new Promise(()=>{}); }; await api.rpc('files/list_folder',{});`);
    await barrier("held");
    held.child.kill("SIGKILL"); await held.result();
    expect(await f.run(`
      assert.equal(config.readAuth().access_token,'fake-A');
      globalThis.fetch=async(url)=>String(url).endsWith('/oauth2/token') ? Response.json({access_token:'recovered-A',expires_in:3600}) : Response.json({ok:true});
      await api.rpc('files/list_folder',{}, {expectedAccountId:'A'});
      assert.equal(config.readAuth().access_token,'recovered-A');
    `)).toMatchObject({ exit: 0 });
  }, 30000);

  test("logout waits for refresh then fences its completion", async () => {
    await seed();
    const refreshing = f.start(`globalThis.fetch=async(url)=> { if(String(url).endsWith('/oauth2/token')) { writeFileSync(join(root,'held'),''); await waitFor('finish'); return Response.json({access_token:'fresh-A',expires_in:3600}); } return Response.json({}); }; await api.rpc('files/list_folder',{});`);
    await barrier("held");
    const logout = f.start(`writeFileSync(join(root,'logout-started'),''); auth.logout();`);
    await barrier("logout-started"); await Bun.sleep(100); release("finish");
    expect(await refreshing.result()).toMatchObject({ exit: 0 });
    expect(await logout.result()).toMatchObject({ exit: 0 });
    expect(await f.run(`assert.equal(config.readAuth(), null);`)).toMatchObject({ exit: 0 });
  }, 30000);

  test("death before or after JSON rename leaves a complete record and durable generation fence", async () => {
    for (const after of [false, true]) {
      await seed();
      expect(await f.run(`writeFileSync(join(root,'generation'),config.beginAuthAttempt());`)).toMatchObject({exit:0});
      const killed = await f.run(`
        const {mock}=await import('bun:test'); const fs=await import('fs'); const rename=fs.renameSync;
        mock.module('fs',()=>({...fs,renameSync:(from,to)=> {
          if(${after}) rename(from,to);
          process.kill(process.pid,'SIGKILL');
        }}));
        config.writeAuth({...fake,account_id:'B',access_token:'fake-B'});
      `);
      expect(killed.exit).not.toBe(0);
      expect(await f.run(`
        const generation=readFileSync(join(root,'generation'),'utf8');
        assert.equal(config.readAuth().account_id,'${after ? "B" : "A"}');
        ${after ? "assert.throws(()=>config.writeAuth(fake,generation),e=>e.code==='auth_superseded');" : "config.writeAuth(fake,generation);"}
        auth.logout(); assert.equal(config.readAuth(),null);
      `)).toMatchObject({exit:0});
    }
  }, 60000);

  test("bounded coordination wait fails closed without dispatch", async () => {
    await seed();
    const held = f.start(`await config.withCredentialStoreAsync(async()=> { writeFileSync(join(root,'held'),''); await Bun.sleep(30000); });`);
    await barrier("held");
    const result = await f.run(`globalThis.fetch=async()=> { throw new Error('DISPATCHED'); }; await api.rpc('files/list_folder',{});`);
    expect(result.exit).not.toBe(0);
    expect(result.stdout).toContain('coordination_timeout');
    expect(result.stderr).not.toContain('DISPATCHED');
    expect(held.child.exitCode).toBeNull();
    held.child.kill("SIGKILL");
  }, 30000);
});
