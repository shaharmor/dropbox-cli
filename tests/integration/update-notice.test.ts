import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { fixture } from "../lib/auth-fixture";

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(async () => { await f.close(); });

const entry = pathToFileURL(join(import.meta.dir, "../../src/index.ts")).href;
const info = ["info", "id:photo", "--machine", "--expected-account", "A"];
// Records every request; GitHub always reports a newer release.
const network = `
  const photo = {'.tag':'file',id:'id:photo',name:'IMG_2.jpg',path_lower:'/photos/img_2.jpg',path_display:'/Photos/IMG_2.jpg',rev:'r1',size:3};
  globalThis.fetch = async (url) => {
    appendFileSync(join(root,'requests'), String(url)+'\\n');
    if (String(url).startsWith('https://api.github.com/')) return Response.json({tag_name:'v99.0.0'});
    return Response.json(photo);
  };
`;

async function cli(args: string[], tty: boolean) {
  return f.run(`config.writeConfig(app); config.writeAuth(fake); ${network}
    ${tty ? "process.stderr.isTTY = true;" : ""}
    process.argv=['bun','dropbox-cli',...${JSON.stringify(args)}]; await import(${JSON.stringify(entry)});`);
}

function requests() {
  const path = join(f.root, "requests");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
}

test("non-interactive runs make no update request and print no notice", async () => {
  const out = await cli(info, false);
  expect(out.exit).toBe(0);
  expect(JSON.parse(out.stdout).data).toMatchObject({ id: "id:photo" });
  expect(requests().some(url => url.includes("github.com"))).toBe(false);
  expect(out.stderr).toBe("");
});

test("interactive runs print the notice on stderr and leave stdout unchanged", async () => {
  const out = await cli(info, true);
  expect(out.exit).toBe(0);
  expect(JSON.parse(out.stdout).data).toMatchObject({ id: "id:photo" });
  expect(out.stderr).toContain("99.0.0");
  expect(out.stderr).toContain("dropbox-cli upgrade");
  expect(requests().filter(url => url.includes("api.github.com"))).toHaveLength(1);

  // The next run within a day makes no further request.
  const again = await cli(info, true);
  expect(again.stderr).toBe("");
  expect(requests().filter(url => url.includes("api.github.com"))).toHaveLength(1);
});
