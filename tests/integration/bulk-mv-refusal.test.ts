import { test, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { fixture, PROCESS_TEST_TIMEOUT_MS } from "../lib/auth-fixture";

setDefaultTimeout(PROCESS_TEST_TIMEOUT_MS);

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(async () => { await f.close(); });

const entry = pathToFileURL(join(import.meta.dir, "../../src/index.ts")).href;
const folderConflict = { error: { ".tag": "path", path: { ".tag": "conflict", conflict: { ".tag": "folder" } } } };

// The destination create answers with the given response. Listing only succeeds after a refresh,
// so a run that proceeds past the create must record list_folder, refresh, list_folder, move_batch_v2.
function workerSetup(status: number, body: unknown) {
  const createResponseBody = typeof body === "string" ? body : JSON.stringify(body);
  return `
    config.writeConfig(app);
    config.writeAuth(fake);
    const requests = [];
    let authenticated = false;
    globalThis.fetch = async (url, options) => {
      const endpoint = String(url).split('/2/')[1] || 'refresh';
      requests.push(endpoint);
      writeFileSync(join(root, 'requests'), JSON.stringify(requests));
      if (endpoint === 'files/create_folder_v2') {
        return new Response(${JSON.stringify(createResponseBody)}, { status: ${status} });
      }
      if (endpoint === 'refresh') {
        authenticated = true;
        return Response.json({ access_token: 'fresh-A', expires_in: 3600 });
      }
      if (endpoint === 'files/list_folder') {
        if (!authenticated) return Response.json({ error: { '.tag': 'invalid_access_token' } }, { status: 401 });
        assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer fresh-A');
        return Response.json({
          entries: [{ '.tag': 'file', name: 'match.jpg', path_display: '/Source/match.jpg' }],
          cursor: 'end',
          has_more: false,
        });
      }
      if (endpoint === 'files/move_batch_v2') {
        return Response.json({ '.tag': 'complete', entries: [{ '.tag': 'success' }] });
      }
      throw new Error('Denied endpoint');
    };
  `;
}

async function runBulkMv(status: number, body: unknown) {
  const argv = `process.argv = ['bun', 'dropbox-cli', 'bulk-mv', '/Source', '/Dest', '--match', 'match'];`;
  return f.run(`${workerSetup(status, body)}${argv}await import(${JSON.stringify(entry)});`);
}

function recordedRequests(): string[] {
  return JSON.parse(readFileSync(join(f.root, "requests"), "utf8"));
}

const refusals: [string, number, unknown][] = [
  ["401 invalid_access_token", 401, { error: { ".tag": "invalid_access_token" } }],
  ["429 too_many_requests", 429, { error: { ".tag": "too_many_requests" } }],
  ["503 internal_error", 503, { error: { ".tag": "internal_error" } }],
  ["409 with a malformed JSON body", 409, "{broken"],
  ["409 with an empty body object", 409, {}],
  ["409 with only a folder-conflict error_summary", 409, { error_summary: "path/conflict/folder/" }],
  ["409 with a flattened folder-conflict tag", 409, { error: { ".tag": "path/conflict/folder" } }],
  ["409 file conflict", 409, { error: { ".tag": "path", path: { ".tag": "conflict", conflict: { ".tag": "file" } } } }],
  ["409 no_write_permission", 409, { error: { ".tag": "path", path: { ".tag": "no_write_permission" } } }],
  ["401 with a folder-conflict body", 401, folderConflict],
  ["500 with a folder-conflict body", 500, folderConflict],
];

test.each(refusals)("bulk create refusal (%s) stops before reads/refresh/moves even when later reads could recover authentication", async (_name, status, body) => {
  const out = await runBulkMv(status, body);

  expect(out.exit).not.toBe(0);
  expect(JSON.parse(out.stdout).ok).toBe(false);
  expect(recordedRequests()).toEqual(["files/create_folder_v2"]);
});

test.each([
  ["a structured existing-folder conflict", 409, folderConflict],
  ["a successful create", 200, { metadata: { id: "id:dest" } }],
] as [string, number, unknown][])("bulk proceeds after %s", async (_name, status, body) => {
  const out = await runBulkMv(status, body);

  expect(out.exit).toBe(0);
  expect(JSON.parse(out.stdout).data.moved).toBe(1);
  expect(recordedRequests()).toEqual([
    "files/create_folder_v2", "files/list_folder", "refresh", "files/list_folder", "files/move_batch_v2",
  ]);
});
