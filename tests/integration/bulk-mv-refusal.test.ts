import { test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { fixture } from "../lib/auth-fixture";

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(async () => { await f.close(); });
const entry = pathToFileURL(join(import.meta.dir, "../../src/index.ts")).href;
const folderConflict = {error:{".tag":"path",path:{".tag":"conflict",conflict:{".tag":"folder"}}}};
function setup(status: number, body: unknown) {
  return `
    config.writeConfig(app);config.writeAuth(fake);
    const requests=[];let authenticated=false;
    globalThis.fetch=async(url,options)=>{
      const endpoint=String(url).split('/2/')[1]||'refresh';
      requests.push(endpoint);writeFileSync(join(root,'requests'),JSON.stringify(requests));
      if(endpoint==='files/create_folder_v2')return new Response(${JSON.stringify(typeof body === "string" ? body : JSON.stringify(body))},{status:${status}});
      if(endpoint==='refresh'){authenticated=true;return Response.json({access_token:'fresh-A',expires_in:3600});}
      if(endpoint==='files/list_folder') {
        if(!authenticated)return Response.json({error:{'.tag':'invalid_access_token'}},{status:401});
        assert.equal(new Headers(options.headers).get('Authorization'),'Bearer fresh-A');
        return Response.json({entries:[{'.tag':'file',name:'match.jpg',path_display:'/Source/match.jpg'}],cursor:'end',has_more:false});
      }
      if(endpoint==='files/move_batch_v2')return Response.json({'.tag':'complete',entries:[{'.tag':'success'}]});
      throw new Error('Denied endpoint');
    };
  `;
}
async function run(status: number, body: unknown) {
  return f.run(`${setup(status, body)}process.argv=['bun','dropbox-cli','bulk-mv','/Source','/Dest','--match','match'];await import(${JSON.stringify(entry)});`);
}

test("bulk create refusal stops before reads/refresh/moves even when later reads could recover authentication", async () => {
  for (const [status, body] of [[401,{error:{".tag":"invalid_access_token"}}],[429,{error:{".tag":"too_many_requests"}}],
    [503,{error:{".tag":"internal_error"}}],[409,"{broken"],[409,{}],[409,{error_summary:"path/conflict/folder/"}],
    [409,{error:{".tag":"path/conflict/folder"}}],[409,{error:{".tag":"path",path:{".tag":"conflict",conflict:{".tag":"file"}}}}],
    [409,{error:{".tag":"path",path:{".tag":"no_write_permission"}}}],[401,folderConflict],[500,folderConflict]] as const) {
    const out=await run(status,body);
    expect(out.exit).not.toBe(0);expect(JSON.parse(out.stdout).ok).toBe(false);
    expect(readFileSync(join(f.root,'requests'),'utf8')).toBe(JSON.stringify(['files/create_folder_v2']));
  }
});

test("bulk proceeds only after structured existing-folder conflict or successful create", async () => {
  for(const [status,body] of [[409,folderConflict],[200,{metadata:{id:'id:dest'}}]] as const) {
    const out=await run(status,body);
    expect(out.exit).toBe(0);expect(JSON.parse(out.stdout).data.moved).toBe(1);
    expect(JSON.parse(readFileSync(join(f.root,'requests'),'utf8'))).toEqual([
      'files/create_folder_v2','files/list_folder','refresh','files/list_folder','files/move_batch_v2',
    ]);
  }
});
