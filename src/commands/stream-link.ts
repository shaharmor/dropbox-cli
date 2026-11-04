import type { Command } from "commander";
import { isContentHash, isId, isText, machineMetadata, machineRpc } from "../lib/machine-api";
import { runMachine } from "../lib/output";
import { MachineError, type MachineOptions } from "../types";

interface StreamLinkOptions extends MachineOptions {
  expectedId?: string;
  expectedCurrentRev?: string;
  expectedHash?: string;
}

type TemporaryLink = {
  metadata?: { id?: unknown; rev?: unknown; content_hash?: unknown };
  link?: unknown;
} | null;

const MAX_FIELD_LENGTH = 1024;
const MAX_LINK_LENGTH = 4096;

function isValidRequest(source: string, options: StreamLinkOptions): boolean {
  return isText(source, MAX_FIELD_LENGTH) && source.startsWith("rev:") && source.length > 4 &&
    isText(options.expectedId, MAX_FIELD_LENGTH) && isId(options.expectedId) &&
    isText(options.expectedCurrentRev, MAX_FIELD_LENGTH) &&
    (options.expectedHash === undefined || isContentHash(options.expectedHash));
}

function isHttpsLink(link: unknown): link is string {
  if (typeof link !== "string" || link.length > MAX_LINK_LENGTH) return false;
  try {
    return new URL(link).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Checks by ID that the reviewed content is still current, then mints a temporary link
 * pinned to the reviewed revision. A replaced file never yields a link to old content.
 */
async function streamLink(source: string, options: StreamLinkOptions): Promise<void> {
  return runMachine(options, async request => {
    if (!isValidRequest(source, options)) {
      throw new MachineError("invalid_args", "Stream link requires one rev: source, --expected-id, --expected-current-rev and an optional 64-hex --expected-hash.");
    }
    const revision = source.slice("rev:".length);

    // With a recorded hash, unchanged content passes even if a move assigned a new revision.
    const current = await machineMetadata(options.expectedId!, request);
    const stillCurrent = options.expectedHash === undefined
      ? current.rev === options.expectedCurrentRev
      : current.content_hash === options.expectedHash;
    if (!stillCurrent) throw new MachineError("identity_mismatch", "The file changed in Dropbox since it was reviewed.");

    const result = await machineRpc<TemporaryLink>("files/get_temporary_link", { path: source }, request);
    const metadata = result?.metadata;
    if (!metadata || metadata.id !== options.expectedId || metadata.rev !== revision ||
      (options.expectedHash !== undefined && metadata.content_hash !== options.expectedHash)) {
      throw new MachineError("identity_mismatch", "Temporary link metadata does not match the reviewed identity/version/hash.");
    }
    // The link is a bearer URL: it is returned only on success and never placed in error evidence.
    if (!isHttpsLink(result!.link)) throw new MachineError("invalid_response", "Dropbox returned an invalid temporary link.");
    return { id: metadata.id, rev: metadata.rev, content_hash: metadata.content_hash, link: result!.link };
  });
}

export function registerStreamLinkCommand(program: Command): void {
  program
    .command("stream-link <source>")
    .description("Mint a temporary streaming link for a reviewed revision that is still current")
    .option("--expected-id <id>", "Recorded Dropbox file identity")
    .option("--expected-current-rev <rev>", "Current revision when no content hash was recorded")
    .option("--expected-hash <hash>", "Optional recorded Dropbox content hash")
    .requiredOption("--expected-account <id>", "Expected Dropbox account")
    .option("--timeout <seconds>", "Request deadline (1–600 seconds)")
    .action((source: string, options: StreamLinkOptions) => streamLink(source, options));
}
