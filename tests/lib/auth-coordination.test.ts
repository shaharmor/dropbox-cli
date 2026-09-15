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
  test("simultaneous near-expiry download and move refresh only once", async () => {
    await seed();
    const worker = (kind: string) => f.start(`
      writeFileSync(join(root, '${kind}-ready'), '');
      await waitFor('go');
      globalThis.fetch = async (url, options) => {
        if (String(url).endsWith('/oauth2/token')) {
          appendFileSync(join(root, 'refreshes'), 'refresh\\n');
          await Bun.sleep(250);
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
    const held = f.start(`globalThis.fetch=async()=> { writeFileSync(join(root,'held'),''); await new Promise(()=>{}); }; await api.rpc('files/list_folder',{});`);
    await barrier("held");
    const result = await f.run(`globalThis.fetch=async()=> { throw new Error('DISPATCHED'); }; await api.rpc('files/list_folder',{});`);
    expect(result.exit).not.toBe(0);
    expect(result.stdout).toContain('coordination_timeout');
    expect(result.stderr).not.toContain('DISPATCHED');
    held.child.kill("SIGKILL");
  }, 30000);
});
