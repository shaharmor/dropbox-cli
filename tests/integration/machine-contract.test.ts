import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, readdirSync, realpathSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { fixture } from "../lib/auth-fixture";

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(async () => { await f.close(); });
const entry = pathToFileURL(join(import.meta.dir, "../../src/index.ts")).href;
const seed = `config.writeConfig(app); config.writeAuth(fake);`;
const metadata = `
  const photo = {'.tag':'file',id:'id:photo',name:'IMG_2.jpg',path_lower:'/photos/img_2.jpg',path_display:'/Photos/IMG_2.jpg',rev:'r1',size:3};
  const parent = {'.tag':'folder',id:'id:photos',name:'Photos',path_lower:'/photos',path_display:'/Photos'};
  const deleted = {'.tag':'folder',id:'id:deleted',name:'deleted',path_lower:'/photos/deleted',path_display:'/Photos/deleted'};
  const absent = () => Response.json({error:{'.tag':'path',path:{'.tag':'not_found'}},error_summary:'path/not_found/'},{status:409,headers:{'x-dropbox-request-id':'request-1'}});
  const requests = [];
  const respond = async (url, init) => {
    const endpoint=String(url).split('/2/')[1], body=JSON.parse(init.body || '{}');
    requests.push({endpoint,body}); appendFileSync(join(root,'requests'),JSON.stringify({endpoint,body})+'\\n');
    assert.equal(new Headers(init.headers).get('Authorization'),'Bearer fake-A');
    if(endpoint==='files/get_metadata') {
      if(body.path==='id:photo') return Response.json(photo);
      if(body.path==='id:photos' || body.path==='/photos') return Response.json(parent);
      if(body.path==='id:deleted' || body.path==='/photos/deleted') return Response.json(deleted);
      if(body.path==='/photos/deleted/img_2.jpg') return absent();
    }
    if(endpoint==='files/move_v2') return Response.json({metadata:{...photo,path_lower:body.to_path.toLowerCase(),path_display:body.to_path}});
    throw new Error('Denied endpoint');
  };
`;
const move = ["mv", "id:photo", "/photos/deleted/IMG_2.jpg", "--safe", "--expected-account", "A", "--expected-rev", "r1", "--expected-source-path", "/photos/IMG_2.jpg", "--source-parent-id", "id:photos", "--destination-parent-id", "id:deleted"];
async function cli(args: string[], setup = "", seeded = true) {
  return f.run(`${seeded ? seed : ""} ${setup}\nprocess.argv=['bun','dropbox-cli',...${JSON.stringify(args)}]; await import(${JSON.stringify(entry)});`);
}
function result(out: {stdout: string}) { return JSON.parse(out.stdout); }
function calls() { return existsSync(join(f.root,"requests")) ? readFileSync(join(f.root,"requests"),"utf8").trim().split("\n").map(line=>JSON.parse(line)) : []; }

test("capabilities advertise only implemented viewer contracts without authentication", async () => {
  const out = await cli(["capabilities"], "", false);
  expect(out.exit).toBe(0);
  expect(result(out).data).toMatchObject({protocol_version:1});
  expect(result(out).data.capabilities).toEqual(["account-status", "login-pkce", "list-page", "metadata", "download-original", "ensure-directory", "move-single"]);
});

test("malformed command arguments are bounded JSON without stack traces or argument echoes", async () => {
  const out=await cli(["mv","--unknown-secret-fake-A"],"",false);
  expect(out.exit).not.toBe(0); expect(result(out).error.code).toBe("invalid_args");
  expect(out.stdout.length).toBeLessThan(16384); expect(out.stderr).toBe(""); expect(out.stdout).not.toContain("fake-A");
});

test("paged listing retains 2050 direct entries across bounded explicit continuation", async () => {
  const setup=`globalThis.fetch=async(url,init)=>{const body=JSON.parse(init.body); if(String(url).endsWith('/continue')) {assert.equal(body.cursor,'next');return Response.json({entries:Array.from({length:50},(_,i)=>({'.tag':'file',id:'id:'+ (2000+i),name:'IMG_'+(2000+i)+'.jpg'})),cursor:'end',has_more:false});} assert.equal(body.recursive,false);assert.equal(body.limit,2000);return Response.json({entries:Array.from({length:2000},(_,i)=>({'.tag':i===0?'folder':'file',id:'id:'+i,name:i===0?'deleted':'IMG_'+i+'.jpg'})),cursor:'next',has_more:true});};`;
  const first=await cli(["ls","/Photos","--page","--page-size","2000","--expected-account","A"],setup);
  expect(first.exit).toBe(0); expect(result(first).data.entries).toHaveLength(2000); expect(result(first).data.has_more).toBe(true);
  const next=await cli(["ls","--page","--cursor",result(first).data.cursor,"--expected-account","A"],setup);
  expect(next.exit).toBe(0); expect(result(next).data.entries).toHaveLength(50); expect(result(next).data.has_more).toBe(false);
  expect(new Set([...result(first).data.entries,...result(next).data.entries].map(e=>e.id)).size).toBe(2050);
});

test("continuation errors preserve nested tags/request ID; invalid paging never dispatches", async () => {
  const failed=await cli(["ls","--page","--cursor","stale","--expected-account","A"], `globalThis.fetch=async()=>Response.json({error:{'.tag':'reset',nested:{'.tag':'expired'}},error_summary:'fake-A fake-refresh'},{status:409,headers:{'x-dropbox-request-id':'req-page'}});`);
  expect(failed.exit).not.toBe(0); expect(result(failed).error).toMatchObject({code:'reset',details:{request_id:'req-page',dropbox:{'.tag':'reset',nested:{'.tag':'expired'}}}});
  expect(failed.stdout).not.toContain('fake-A'); expect(failed.stdout).not.toContain('fake-refresh');
  for(const flags of [["--recursive"],["--page-size","0"],["--page-size","2001"],["--type","file"]]) {
    const out=await cli(["ls","--page","--expected-account","A",...flags]); expect(result(out).error.code).toBe("invalid_args");
  }
});

test("machine metadata is identity/account bound and preserves informational sharing fields", async () => {
  const out=await cli(["info","id:photo","--machine","--expected-account","A"],metadata+`photo.sharing_info={parent_shared_folder_id:'shared-1'};globalThis.fetch=respond;`);
  expect(out.exit).toBe(0); expect(result(out).data).toMatchObject({id:'id:photo',rev:'r1',sharing_info:{parent_shared_folder_id:'shared-1'}});
  const mismatch=await cli(["info","id:photo","--machine","--expected-account","B"],metadata+`globalThis.fetch=respond;`);
  expect(result(mismatch).error.code).toBe('account_mismatch');
  expect(calls()).toHaveLength(1);
});

test("safe single move submits ID once with no overwrite/ownership transfer, including execution-override sharing cases", async () => {
  for(const sharing of ["", "photo.sharing_info={parent_shared_folder_id:'same'};deleted.sharing_info={shared_folder_id:'same'};", "photo.sharing_info={parent_shared_folder_id:'source'};deleted.sharing_info={shared_folder_id:'different'};"]) {
    const out=await cli(move,metadata+sharing+`globalThis.fetch=respond;`);
    expect(out.exit).toBe(0); expect(result(out).data).toMatchObject({outcome:'confirmed',metadata:{id:'id:photo',rev:'r1',path_lower:'/photos/deleted/img_2.jpg'}});
  }
  const submitted=calls().filter(c=>c.endpoint==='files/move_v2'); expect(submitted).toHaveLength(3);
  for(const call of submitted) expect(call.body).toEqual({from_path:'id:photo',to_path:'/photos/deleted/IMG_2.jpg',autorename:false,allow_ownership_transfer:false});
  expect(calls().every(c=>['files/get_metadata','files/move_v2'].includes(c.endpoint))).toBe(true);
});

test("known source revision/location or folder identity drift blocks dispatch", async () => {
  for(const drift of ["photo.rev='r2';", "photo.path_lower='/elsewhere/img_2.jpg';", "deleted.id='id:replacement';", "parent.path_lower='/renamed';"]) {
    const out=await cli(move,metadata+drift+`globalThis.fetch=respond;`);
    expect(out.exit).not.toBe(0); expect(result(out).error.details.outcome).toBe('not_submitted');
  }
  expect(calls().some(c=>c.endpoint==='files/move_v2')).toBe(false);
});

test("file/folder destination conflicts preserve both objects, and server refusals retain authoritative evidence", async () => {
  for(const kind of ['file','folder']) {
    const out=await cli(move,metadata+`globalThis.fetch=async(url,init)=>JSON.parse(init.body).path==='/photos/deleted/img_2.jpg'?Response.json({...photo,'.tag':'${kind}',id:'id:existing',path_lower:'/photos/deleted/img_2.jpg',path_display:'/photos/deleted/IMG_2.jpg'}):respond(url,init);`);
    expect(result(out).error).toMatchObject({code:'destination_conflict',details:{outcome:'not_submitted'}});
  }
  const out=await cli(move,metadata+`globalThis.fetch=async(url,init)=>String(url).endsWith('/move_v2')?Response.json({error:{'.tag':'to',to:{'.tag':'conflict',conflict:{'.tag':'file'}}}},{status:409,headers:{'x-dropbox-request-id':'req-move'}}):respond(url,init);`);
  expect(result(out).error.details).toMatchObject({outcome:'refused',request_id:'req-move',http_status:409,dropbox:{'.tag':'to',to:{'.tag':'conflict',conflict:{'.tag':'file'}}}});
});

test("lost ack, delayed application, HTTP errors and malformed success remain unknown without replay", async () => {
  for(const fault of ["throw new Error('fake-A connection lost')", "await new Promise(()=>{})", "return new Response('{}',{status:503})", "return new Response('{broken')", "return Response.json({metadata:{...photo,id:'id:other'}})"]) {
    const out=await cli([...move,"--timeout","1"],metadata+`globalThis.fetch=async(url,init)=>{if(String(url).endsWith('/move_v2')){appendFileSync(join(root,'mutations'),'once\\n');${fault};}return respond(url,init);};`);
    expect(out.exit).not.toBe(0); expect(result(out).error).toMatchObject({code:'unknown_outcome',details:{outcome:'unknown'}});
    expect(out.stdout).not.toContain('fake-A');
  }
  expect(readFileSync(join(f.root,'mutations'),'utf8').trim().split('\n')).toHaveLength(5);
  // A separate source-present read is not terminal refusal evidence for an earlier attempt.
  const info=await cli(['info','id:photo','--machine','--expected-account','A'],metadata+`globalThis.fetch=respond;`);
  expect(result(info).data.id).toBe('id:photo'); expect(result(info).data.outcome).toBeUndefined();
}, 15000);

test("Retry-After is bounded timing evidence, never refusal evidence or mutation replay permission", async () => {
  for (const [header, expected] of [["3600", 3600], ["0", 0], [" 120 ", 120], [null, undefined], ["", undefined],
    ["-1", undefined], ["1.5", undefined], ["NaN", undefined], ["Infinity", undefined], ["1e3", undefined],
    ["9".repeat(100), undefined], ["9007199254740991", undefined], ["fake-A".repeat(50), undefined]] as const) {
    const out = await cli(move, metadata + `globalThis.fetch=async(url,init)=>{
      if(String(url).endsWith('/move_v2')){appendFileSync(join(root,'retry-submitted'),'once\\n');
        return Response.json({error:{'.tag':'to',to:{'.tag':'conflict'}}},{status:409,headers:${JSON.stringify(header === null ? {} : {"Retry-After": header})}});}
      return respond(url,init);};`);
    expect(result(out).error.details.outcome).toBe('refused');
    expect(result(out).error.details.retry_after_seconds).toBe(expected);
    expect(out.stdout).not.toContain('fake-A');
  }
  const unknown = await cli(move, metadata + `globalThis.fetch=async(url,init)=>{
    if(String(url).endsWith('/move_v2')){appendFileSync(join(root,'retry-submitted'),'once\\n');
      return Response.json({error:{'.tag':'too_many_requests'}},{status:429,headers:{'Retry-After':'3600'}});}
    return respond(url,init);};`);
  expect(result(unknown).error.details).toMatchObject({outcome:'unknown',retry_after_seconds:3600});
  expect(readFileSync(join(f.root,'retry-submitted'),'utf8').trim().split('\n')).toHaveLength(14);
});

test("Retry-After HTTP-date uses receipt time, and invalid date text is omitted", async () => {
  const fixed = Date.UTC(2030, 0, 1);
  for (const [header, expected] of [[new Date(fixed + 7200_000).toUTCString(), 7200], [new Date(fixed - 1000).toUTCString(), 0],
    ['tomorrow', undefined], ['2030-01-01', undefined], ['Tue, 32 Jan 2030 00:00:00 GMT', undefined]] as const) {
    const out = await cli(move, metadata + `Date.now=()=>${fixed};config.writeAuth({...fake,expires_at:${fixed / 1000 + 3600}});globalThis.fetch=async(url,init)=>{
      if(String(url).endsWith('/move_v2'))return Response.json({error:{'.tag':'to'}},{status:409,headers:{'Retry-After':${JSON.stringify(header)}}});
      return respond(url,init);};`);
    expect(result(out).error.details.outcome).toBe('refused');
    expect(result(out).error.details.retry_after_seconds).toBe(expected);
  }
  const malformed = await cli(move, metadata + `globalThis.fetch=async(url,init)=>String(url).endsWith('/move_v2')?
    new Response('{broken',{status:409,headers:{'Retry-After':'120'}}):respond(url,init);`);
  expect(result(malformed).error.details).toMatchObject({outcome:'unknown',retry_after_seconds:120});
});

test("safe mkdir inspects exact existing folder on conflict, never autorenames and propagates permissions", async () => {
  const args=['mkdir','/photos/deleted','--safe','--parent-id','id:photos','--expected-account','A'];
  const existing=await cli(args,metadata+`globalThis.fetch=respond;`);
  expect(existing.exit).toBe(0); expect(result(existing).data).toMatchObject({created:false,metadata:{id:'id:deleted'}});
  const create=await cli(args,metadata+`let made=false;globalThis.fetch=async(url,init)=>{const b=JSON.parse(init.body);if(String(url).endsWith('/create_folder_v2')){assert.equal(b.autorename,false);made=true;return Response.json({metadata:deleted});}if(b.path==='/photos/deleted'&&!made)return absent();return respond(url,init);};`);
  expect(create.exit).toBe(0); expect(result(create).data.created).toBe(true);
  const denied=await cli(args,metadata+`globalThis.fetch=async(url,init)=>{if(String(url).endsWith('/create_folder_v2'))return Response.json({error:{'.tag':'path',path:{'.tag':'no_write_permission'}}},{status:409});if(JSON.parse(init.body).path==='/photos/deleted')return absent();return respond(url,init);};`);
  expect(result(denied).error.details).toMatchObject({outcome:'refused',dropbox:{path:{'.tag':'no_write_permission'}}});
});

function downloadArgs(path: string) { return ['download','rev:r1','--output-file',path,'--expected-id','id:photo','--expected-account','A']; }
const streamSetup=`
  const {createHash}=await import('node:crypto');
  const bytes=Buffer.alloc(5*1024*1024+17,42);
  const hashes=[]; for(let i=0;i<bytes.length;i+=4*1024*1024)hashes.push(createHash('sha256').update(bytes.subarray(i,i+4*1024*1024)).digest());
  const hash=createHash('sha256').update(Buffer.concat(hashes)).digest('hex');
  globalThis.fetch=async(url,init)=>{assert.equal(JSON.parse(new Headers(init.headers).get('Dropbox-API-Arg')).path,'rev:r1');let offset=0;return new Response(new ReadableStream({pull(c){if(offset===bytes.length){c.close();return;}c.enqueue(bytes.subarray(offset,offset+65536));offset=Math.min(offset+65536,bytes.length);}}),{headers:{'Dropbox-API-Result':JSON.stringify({id:'id:photo',rev:'r1',size:bytes.length,content_hash:hash,name:'untrusted-name.jpg'})}});};
`;
test("5 MiB Unicode original streams to exact absolute output with identity, Dropbox hash and size", async () => {
  const path=join(realpathSync(f.root),'照片 ; $(never).HEIC');
  const out=await cli(downloadArgs(path),streamSetup);
  expect(out.exit).toBe(0); expect(result(out).data).toMatchObject({id:'id:photo',rev:'r1',size:5*1024*1024+17,local_path:path});
  expect(readFileSync(path)).toEqual(Buffer.alloc(5*1024*1024+17,42));
  expect(readdirSync(f.root).some(n=>n.endsWith('.part'))).toBe(false);
});

test("download rejects pre-existing outputs/symlink ancestors and relative or multiple sources before network", async () => {
  const root=realpathSync(f.root), output=join(root,'out');
  for(const setup of [`writeFileSync(${JSON.stringify(output)},'keep');`, `const fs=await import('node:fs');fs.symlinkSync('missing',${JSON.stringify(output)});`]) {
    const out=await cli(downloadArgs(output),setup); expect(out.exit).not.toBe(0); expect(result(out).error.details.outcome).toBe('not_submitted');
    const fs=await import('fs'); fs.unlinkSync(output);
  }
  const out=await cli(downloadArgs(join(root,'link','out')),`const fs=await import('node:fs');fs.symlinkSync(root,join(root,'link'));`);
  expect(result(out).error.code).toBe('unsafe_output');
  for(const args of [downloadArgs('relative'), [...downloadArgs(output),'rev:other']]) expect(result(await cli(args)).error.code).toBe('invalid_args');
});

test("stream errors, integrity mismatch, cancellation and publication collision never publish partial data", async () => {
  const root=realpathSync(f.root);
  for(const fault of ['stream','hash','identity','size','cancel','collision']) {
    const path=join(root,fault);
    const out=await cli([...downloadArgs(path),'--timeout','1'],`
      globalThis.fetch=async()=>new Response(new ReadableStream({async start(c){c.enqueue(new Uint8Array([1,2,3]));
        ${fault==='stream'?"c.error(new Error('network lost'));":fault==='cancel'?"await new Promise(()=>{});":fault==='collision'?`writeFileSync(${JSON.stringify(path)},'keep');c.close();`:"c.close();"}
      }}),{headers:{'Dropbox-API-Result':JSON.stringify({id:'${fault==='identity'?'id:wrong':'id:photo'}',rev:'r1',size:${fault==='size'?4:3},${fault==='hash'?"content_hash:'0'.repeat(64),":""}})}});
    `);
    expect(out.exit).not.toBe(0); expect(result(out).ok).toBe(false);
    if(fault==='collision') expect(readFileSync(path,'utf8')).toBe('keep'); else expect(existsSync(path)).toBe(false);
    expect(readdirSync(root).some(n=>n.endsWith('.part'))).toBe(false);
  }
},15000);

test("safe creation accepts the provider's untagged FolderMetadata; folder races inspect only after terminal conflict", async () => {
  const args=['mkdir','/photos/deleted','--safe','--parent-id','id:photos','--expected-account','A'];
  for(const race of [false,true]) {
    const out=await cli(args,metadata+`let submitted=false;globalThis.fetch=async(url,init)=>{const b=JSON.parse(init.body);if(String(url).endsWith('/create_folder_v2')){assert.equal(submitted,false);submitted=true;${race ? "return Response.json({error:{'.tag':'path',path:{'.tag':'conflict',conflict:{'.tag':'folder'}}}},{status:409});" : "const {['.tag']:tag,...folder}=deleted;return Response.json({metadata:folder});"}}if(b.path==='/photos/deleted'&&!submitted)return absent();return respond(url,init);};`);
    expect(out.exit).toBe(0); expect(result(out).data).toMatchObject({created:!race,metadata:{'.tag':'folder',id:'id:deleted'}});
  }
});

test("restore uses the same checked ID path and leaves collisions unresolved", async () => {
  const args=['mv','id:photo','/photos/IMG_2.jpg','--safe','--expected-account','A','--expected-rev','r1','--expected-source-path','/photos/deleted/IMG_2.jpg','--source-parent-id','id:deleted','--destination-parent-id','id:photos'];
  const setup=metadata+`photo.path_lower='/photos/deleted/img_2.jpg';photo.path_display='/Photos/deleted/IMG_2.jpg';photo.sharing_info={parent_shared_folder_id:'other'};globalThis.fetch=async(url,init)=>{if(JSON.parse(init.body).path==='/photos/img_2.jpg')return absent();return respond(url,init);};`;
  const out=await cli(args,setup); expect(out.exit).toBe(0); expect(result(out).data.metadata.path_lower).toBe('/photos/img_2.jpg');
  const conflict=await cli(args,metadata+`photo.path_lower='/photos/deleted/img_2.jpg';globalThis.fetch=async(url,init)=>JSON.parse(init.body).path==='/photos/img_2.jpg'?Response.json({...photo,id:'id:replacement',path_lower:'/photos/img_2.jpg'}):respond(url,init);`);
  expect(result(conflict).error.code).toBe('destination_conflict'); expect(calls().filter(c=>c.endpoint==='files/move_v2')).toHaveLength(1);
});

test("server-applied lost acknowledgment remains unknown and a later read observes the same moved ID", async () => {
  const out=await cli(move,metadata+`globalThis.fetch=async(url,init)=>{if(String(url).endsWith('/move_v2')){const b=JSON.parse(init.body);writeFileSync(join(root,'applied'),JSON.stringify({...photo,path_lower:b.to_path.toLowerCase(),path_display:b.to_path}));appendFileSync(join(root,'submitted'),'once\\n');throw new Error('ack lost');}return respond(url,init);};`);
  expect(result(out).error.details.outcome).toBe('unknown');
  const observed=await cli(['info','id:photo','--machine','--expected-account','A'],`globalThis.fetch=async()=>Response.json(JSON.parse(readFileSync(join(root,'applied'),'utf8')));`);
  expect(result(observed).data).toMatchObject({id:'id:photo',rev:'r1',path_lower:'/photos/deleted/img_2.jpg'});
  expect(readFileSync(join(f.root,'submitted'),'utf8')).toBe('once\n');
});

test("mkdir uncertainty is not converted into success or retried; file conflicts do not become folders", async () => {
  const args=['mkdir','/photos/deleted','--safe','--parent-id','id:photos','--expected-account','A'];
  const lost=await cli(args,metadata+`globalThis.fetch=async(url,init)=>{if(String(url).endsWith('/create_folder_v2')){appendFileSync(join(root,'created'),'once\\n');throw new Error('ack lost');}if(JSON.parse(init.body).path==='/photos/deleted')return absent();return respond(url,init);};`);
  expect(result(lost).error.details.outcome).toBe('unknown'); expect(readFileSync(join(f.root,'created'),'utf8')).toBe('once\n');
  const conflict=await cli(args,metadata+`globalThis.fetch=async(url,init)=>JSON.parse(init.body).path==='/photos/deleted'?Response.json({...photo,path_lower:'/photos/deleted'}):respond(url,init);`);
  expect(result(conflict).error.code).toBe('destination_conflict');
});

test("machine download transport itself requires an expected account before dispatch", async () => {
  const out=await f.run(`${seed}globalThis.fetch=async()=>{throw new Error('DISPATCHED');};await assert.rejects(()=>api.machineDownload('rev:r1',{}),e=>e.code==='invalid_args');`);
  expect(out.exit).toBe(0);
});

test("source pathname replacement never retargets the ID-addressed submission", async () => {
  const out=await cli(move,metadata+`globalThis.fetch=async(url,init)=>{const b=JSON.parse(init.body);assert.notEqual(b.path,'/photos/img_2.jpg');if(String(url).endsWith('/move_v2'))assert.equal(b.from_path,'id:photo');return respond(url,init);};`);
  expect(out.exit).toBe(0); expect(calls().filter(c=>c.endpoint==='files/move_v2')).toHaveLength(1);
});

test("401/429 mutation responses never refresh/retry, while malformed refusals remain unknown", async () => {
  for(const status of [401,429,409]) {
    const out=await cli(move,metadata+`globalThis.fetch=async(url,init)=>{if(String(url).endsWith('/move_v2')){appendFileSync(join(root,'submitted'),'once\\n');return new Response('${status===401 ? '{"error":{".tag":"invalid_access_token"}}' : '{}'}',{status:${status}});}return respond(url,init);};`);
    expect(result(out).error.details.outcome).toBe(status===401?'refused':'unknown');
    if(status===401) expect(result(out).error).toMatchObject({code:'auth_error',message:'Dropbox authentication was refused. Reconnect the account.',details:{http_status:401,dropbox:{'.tag':'invalid_access_token'}}});
  }
  expect(readFileSync(join(f.root,'submitted'),'utf8').trim().split('\n')).toHaveLength(3);
});

test("safe mode never falls back to legacy operations when arguments/account are missing", async () => {
  for(const args of [[...move,'--autorename'],move.filter((_,i)=>i!==4&&i!==5),['download','rev:r1','--expected-account','A'],['mkdir','/photos/deleted','--expected-account','A'],['mv','/photos/IMG_2.jpg',...move.slice(2)],['mv',...move.slice(1),'id:extra']]) {
    const out=await cli(args,metadata+`globalThis.fetch=respond;`);
    expect(out.exit).not.toBe(0); expect(result(out).error.details.outcome).toBe('not_submitted');
  }
  expect(calls()).toHaveLength(0);
});

test("malformed and oversized RPC output fail bounded; stdout and stderr drain under pressure", async () => {
  for(const payload of ["'{broken'", "'x'.repeat(3*1024*1024)"]) {
    const out=await cli(['info','id:photo','--machine','--expected-account','A'],`globalThis.fetch=async()=>new Response(${payload});`);
    expect(result(out).error.code).toBe('invalid_response'); expect(out.stdout.length).toBeLessThan(16384); expect(out.stderr).toBe('');
  }
  const out=await cli(['ls','--page','--expected-account','A','--verbose'],`process.stderr.write('diagnostic '.repeat(100000));globalThis.fetch=async()=>Response.json({entries:Array.from({length:2000},(_,i)=>({'.tag':'file',id:'id:'+i,name:'照片'.repeat(100)+i+'.jpg'})),cursor:'end',has_more:false});`);
  expect(out.exit).toBe(0); expect(result(out).data.entries).toHaveLength(2000); expect(out.stderr.length).toBeGreaterThan(1000000);
});

test("read backoff deadline cancels the timer and exits promptly without another dispatch", async () => {
  const started=Date.now();
  const out=await cli(['ls','--page','--expected-account','A','--timeout','1'],`globalThis.fetch=async()=>{appendFileSync(join(root,'backoff-dispatch'),'once\\n');return new Response('{}',{status:429,headers:{'Retry-After':'5'}});};`);
  const elapsed=Date.now()-started;
  expect(result(out).error).toMatchObject({code:'cancelled',details:{outcome:'not_submitted',http_status:429,retry_after_seconds:5}});
  expect(readFileSync(join(f.root,'backoff-dispatch'),'utf8')).toBe('once\n');
  expect(elapsed).toBeLessThan(2500);
},10000);

test("SIGTERM during read backoff exits promptly and releases abort listeners", async () => {
  const worker=f.start(`${seed}globalThis.fetch=async()=>{appendFileSync(join(root,'backoff-signal'),'once\\n');return new Response('{}',{status:429,headers:{'Retry-After':'5'}});};process.argv=['bun','dropbox-cli','ls','--page','--expected-account','A'];await import(${JSON.stringify(entry)});`);
  const deadline=Date.now()+5000;
  while(!existsSync(join(f.root,'backoff-signal'))) {if(Date.now()>deadline)throw new Error('Fixture did not start');await Bun.sleep(10);}
  await Bun.sleep(100);
  const started=Date.now();worker.child.kill('SIGTERM');const out=await worker.result();
  expect(result(out).error).toMatchObject({code:'cancelled',details:{outcome:'not_submitted',http_status:429,retry_after_seconds:5}});
  expect(readFileSync(join(f.root,'backoff-signal'),'utf8')).toBe('once\n');
  expect(Date.now()-started).toBeLessThan(1500);
  const listeners=await f.run(`const c=new AbortController();let attached=0;const add=c.signal.addEventListener.bind(c.signal),remove=c.signal.removeEventListener.bind(c.signal);c.signal.addEventListener=(...args)=>{attached++;add(...args);};c.signal.removeEventListener=(...args)=>{attached--;remove(...args);};c.abort();await assert.rejects(()=>api.waitForRequest(new Promise(()=>{}),c.signal));assert.equal(attached,0);`);
  expect(listeners.exit).toBe(0);
},10000);

test("SIGTERM cancels a streaming original and SIGKILL leaves only an unpublished staging file", async () => {
  for(const signal of ['SIGTERM','SIGKILL'] as const) {
    const output=join(realpathSync(f.root),signal);
    const worker=f.start(`${seed} globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));writeFileSync(join(root,'${signal}-ready'),'');}}),{headers:{'Dropbox-API-Result':JSON.stringify({id:'id:photo',rev:'r1',size:300})}});process.argv=['bun','dropbox-cli',...${JSON.stringify(downloadArgs(output))}];await import(${JSON.stringify(entry)});`);
    const deadline=Date.now()+5000;
    while(!existsSync(join(f.root,signal+'-ready'))) {if(Date.now()>deadline)throw new Error('Fixture did not start');await Bun.sleep(10);}
    worker.child.kill(signal); const out=await worker.result();
    expect(out.exit).not.toBe(0); expect(existsSync(output)).toBe(false);
    if(signal==='SIGTERM') { expect(result(out).error.code).toBe('cancelled');expect(readdirSync(f.root).some(n=>n.endsWith('.part'))).toBe(false); }
    else expect(readdirSync(f.root).some(n=>n.endsWith('.part'))).toBe(true);
  }
},15000);
