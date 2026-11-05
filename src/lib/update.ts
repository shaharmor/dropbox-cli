import { createHash, randomUUID } from "crypto";
import { accessSync, chmodSync, constants, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import pkg from "../../package.json";

const REPO = "shaharmor/dropbox-cli";
export const RELEASES_URL = `https://github.com/${REPO}/releases`;
export const CURRENT_VERSION = pkg.version;

export class UpgradeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function parseVersion(value: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match ? match.slice(1).map(Number) : null;
}

/** True when `candidate` is a strictly higher `major.minor.patch` than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return false;
}

/** The release asset for this platform, or null when no binary is published for it. */
export function assetName(platform: string = process.platform, arch: string = process.arch): string | null {
  if (platform !== "darwin" && platform !== "linux") return null;
  if (arch !== "arm64" && arch !== "x64") return null;
  return `dropbox-cli-${platform}-${arch}`;
}

async function get(url: string, signal?: AbortSignal): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch {
    throw new UpgradeError("upgrade_failed", "Could not reach GitHub.");
  }
  if (!response.ok) throw new UpgradeError("upgrade_failed", `GitHub returned HTTP ${response.status}.`);
  return response;
}

export async function latestRelease(signal?: AbortSignal): Promise<{ tag: string; version: string }> {
  const response = await get(`https://api.github.com/repos/${REPO}/releases/latest`, signal);
  const body = await response.json().catch(() => null) as { tag_name?: unknown } | null;
  const tag = body?.tag_name;
  if (typeof tag !== "string" || !parseVersion(tag)) {
    throw new UpgradeError("upgrade_failed", "The latest release has no valid version tag.");
  }
  return { tag, version: tag.replace(/^v/, "") };
}

/**
 * Downloads `asset` from release `tag`, verifies it against the release's checksums.txt, and
 * atomically renames it over `target`. Writing into the existing file is avoided because macOS
 * caches code signatures per inode. Any failure leaves `target` untouched.
 */
export async function replaceBinary(target: string, tag: string, asset: string): Promise<void> {
  const dir = dirname(target);
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    throw new UpgradeError("permission_denied", `Cannot write to ${dir}. Re-run with permission to replace ${target}.`);
  }

  const base = `https://github.com/${REPO}/releases/download/${tag}`;
  const [binary, sums] = await Promise.all([
    get(`${base}/${asset}`).then(response => response.arrayBuffer()),
    get(`${base}/checksums.txt`).then(response => response.text()),
  ]);
  const expected = sums.split("\n")
    .map(line => line.trim().split(/\s+/))
    .find(([, name]) => name?.replace(/^\*/, "") === asset)?.[0];
  if (!expected) throw new UpgradeError("checksum_mismatch", `checksums.txt has no entry for ${asset}.`);
  const actual = createHash("sha256").update(new Uint8Array(binary)).digest("hex");
  if (actual !== expected.toLowerCase()) {
    throw new UpgradeError("checksum_mismatch", `Downloaded ${asset} does not match its published checksum.`);
  }

  const temporary = join(dir, `.dropbox-cli.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, new Uint8Array(binary), { mode: 0o755 });
    chmodSync(temporary, 0o755);
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* never created or already renamed */ }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new UpgradeError("permission_denied", `Cannot replace ${target}.`);
    }
    throw new UpgradeError("upgrade_failed", `Could not replace ${target}.`);
  }
}
