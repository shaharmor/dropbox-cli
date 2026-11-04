import type { Command } from "commander";
import { contentDownload } from "../lib/api";
import { isContentHash, isId, machineDownload } from "../lib/machine-api";
import { printSuccess, formatBytes, runMachine } from "../lib/output";
import { waitForRequest } from "../lib/streams";
import { CredentialError, MachineError, type MachineOptions } from "../types";
import { constants, existsSync, mkdirSync, writeFileSync } from "fs";
import { open, lstat, link, unlink, type FileHandle } from "fs/promises";
import { createHash, randomUUID } from "crypto";
import { logHuman } from "../lib/logger";
import { basename, join, dirname, resolve, isAbsolute, parse } from "path";

interface OutputOptions extends MachineOptions {
  outputFile?: string;
  expectedId?: string;
  expectedHash?: string;
  progress?: boolean;
}

const CONTENT_HASH_BLOCK_BYTES = 4 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 100;
const NEW_PRIVATE_FILE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/** Dropbox content_hash: SHA-256 over the concatenated SHA-256 digests of each 4 MiB block. */
class ContentHasher {
  private readonly overall = createHash("sha256");
  private block = createHash("sha256");
  private blockBytes = 0;

  update(chunk: Uint8Array): void {
    for (let offset = 0; offset < chunk.length;) {
      const count = Math.min(CONTENT_HASH_BLOCK_BYTES - this.blockBytes, chunk.length - offset);
      this.block.update(chunk.subarray(offset, offset + count));
      this.blockBytes += count;
      offset += count;
      if (this.blockBytes === CONTENT_HASH_BLOCK_BYTES) this.finishBlock();
    }
  }

  digest(): string {
    if (this.blockBytes) this.finishBlock();
    return this.overall.digest("hex");
  }

  private finishBlock(): void {
    this.overall.update(this.block.digest());
    this.block = createHash("sha256");
    this.blockBytes = 0;
  }
}

/** Writes rate-limited JSON progress lines to stderr; stdout keeps the single result envelope. */
function progressReporter(enabled: boolean, totalBytes: number) {
  let lastReport = -Infinity;
  return (downloadedBytes: number, force = false): void => {
    if (!enabled) return;
    const now = performance.now();
    if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return;
    process.stderr.write(JSON.stringify({
      type: "download_progress", downloaded_bytes: downloadedBytes, total_bytes: totalBytes,
    }) + "\n");
    lastReport = now;
  };
}

function isValidDownload(sources: string[], options: OutputOptions): boolean {
  const [source] = sources;
  const output = options.outputFile;
  return sources.length === 1 && !!source?.startsWith("rev:") && source.length > 4 &&
    isId(options.expectedId) &&
    !!output && isAbsolute(output) && !output.includes("\0") && resolve(output) === output &&
    (options.expectedHash === undefined || isContentHash(options.expectedHash));
}

function matchesRecordedFile(metadata: Record<string, unknown>, revision: string, options: OutputOptions): boolean {
  return metadata.id === options.expectedId && metadata.rev === revision &&
    Number.isSafeInteger(metadata.size) && (metadata.size as number) >= 0 &&
    isContentHash(metadata.content_hash) &&
    (options.expectedHash === undefined || metadata.content_hash === options.expectedHash);
}

// Standard filesystem safety, not protection against concurrent same-user ancestor swaps.
async function checkOutput(path: string): Promise<void> {
  let current = parse(path).root;
  for (const part of dirname(path).slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new MachineError("unsafe_output", "Output ancestors must be existing nonsymlink directories.");
    }
  }
  try {
    const stat = await lstat(path);
    throw new MachineError(
      stat.isSymbolicLink() ? "unsafe_output" : "output_exists",
      "Output already exists; it will not be replaced.",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function writeAll(file: FileHandle, chunk: Uint8Array, signal?: AbortSignal): Promise<void> {
  for (let offset = 0; offset < chunk.length;) {
    signal?.throwIfAborted();
    const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
    if (!bytesWritten) throw new MachineError("local_io_error", "Unable to write the staging file.");
    offset += bytesWritten;
  }
}

/**
 * Streams one file revision into an exclusive `.part` file next to the output, verifies its
 * size and Dropbox content hash, then publishes it with a hard link that never replaces.
 */
async function downloadOriginal(sources: string[], options: OutputOptions): Promise<void> {
  return runMachine(options, async request => {
    if (!isValidDownload(sources, options)) {
      throw new MachineError("invalid_args", "Original download requires one rev: source, --expected-id and an absolute normalized --output-file.");
    }
    const source = sources[0]!;
    const output = options.outputFile!;

    let stage: string | undefined;
    let file: FileHandle | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await checkOutput(output);
      stage = join(dirname(output), `.dropbox-${randomUUID()}.part`);
      file = await open(stage, NEW_PRIVATE_FILE, 0o600);

      const download = await machineDownload(source, request);
      reader = download.body.getReader();
      const meta = download.metadata;
      if (!matchesRecordedFile(meta, source.slice("rev:".length), options)) {
        throw new MachineError("identity_mismatch", "Download metadata does not match the recorded identity/version/hash.");
      }
      const size = meta.size as number;

      const hasher = new ContentHasher();
      const reportProgress = progressReporter(!!options.progress, size);
      let total = 0;
      reportProgress(total);
      while (true) {
        const { done, value } = await waitForRequest(reader.read(), request.signal);
        if (done) break;
        total += value.length;
        if (total > size) throw new MachineError("integrity_error", "Download exceeded the declared size.");
        hasher.update(value);
        await writeAll(file, value, request.signal);
        reportProgress(total);
      }
      reportProgress(total, true);
      if (total !== size || meta.content_hash !== hasher.digest()) {
        throw new MachineError("integrity_error", "Download size or Dropbox content hash did not match.");
      }

      await file.sync();
      await file.close();
      file = undefined;
      await checkOutput(output);
      request.signal?.throwIfAborted();
      // Hard-link publication is atomic and fails if any object already occupies output.
      await link(stage, output);
      // The verified original is already published; a leftover stage must not turn success into failure.
      const published = stage;
      stage = undefined;
      await unlink(published).catch(() => {});
      return { id: meta.id, rev: meta.rev, content_hash: meta.content_hash, size: total, local_path: output };
    } catch (error) {
      if (error instanceof MachineError) throw error;
      if (error instanceof CredentialError) throw error;
      throw new MachineError(
        request.signal?.aborted ? "cancelled" : "download_error",
        "Original download was not completed; no partial file is published.",
      );
    } finally {
      if (reader) {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      await file?.close().catch(() => {});
      if (stage) await unlink(stage).catch(() => {});
    }
  });
}

async function downloadSingleFile(
  remotePath: string,
  localDir: string
): Promise<{ remote_path: string; local_path: string; size: number }> {
  const { metadata, body } = await contentDownload("files/download", {
    path: remotePath,
  });

  const fileName = (metadata as { name?: string }).name || basename(remotePath);
  const localPath = resolve(join(localDir, fileName));

  // Ensure local directory exists
  const dir = dirname(localPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  logHuman(`Downloading ${fileName}...`);

  // Stream to file
  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const fullContent = Buffer.concat(chunks);
  writeFileSync(localPath, fullContent);

  logHuman(`  Saved to: ${localPath} (${formatBytes(fullContent.length)})`);

  return {
    remote_path: remotePath,
    local_path: localPath,
    size: fullContent.length,
  };
}

export function registerDownloadCommand(program: Command): void {
  program
    .command("download <sources...>")
    .description(
      "Download file(s) from Dropbox. Last argument is the local directory (defaults to current directory)."
    )
    .option("--output-file <path>", "Machine mode: exact absolute output, never overwrite")
    .option("--expected-id <id>", "Recorded Dropbox file identity")
    .option("--expected-hash <hash>", "Optional recorded Dropbox content hash")
    .option("--progress", "Machine mode: bounded-rate byte progress as JSON lines on stderr")
    .option("--expected-account <id>", "Required account identity for machine mode")
    .option("--timeout <seconds>", "Machine request deadline (1–600 seconds)")
    .addHelpText("after", `
Examples:
  $ dropbox-cli download /Documents/report.pdf             Download to current directory
  $ dropbox-cli download /Documents/report.pdf ./local     Download to a specific directory
  $ dropbox-cli download /Photos/a.jpg /Photos/b.jpg .     Download multiple files`)
    .action(async (sources: string[], options: OutputOptions) => {
      // Any machine flag routes to the checked path so an incomplete invocation fails closed.
      if (Object.keys(options).length) return downloadOriginal(sources, options);
      // If only one arg, download to current dir
      // If multiple args, last one is local destination
      let remotePaths: string[];
      let localDir: string;

      if (sources.length === 1) {
        remotePaths = [sources[0]];
        localDir = ".";
      } else {
        // Check if last arg looks like a remote path (starts with /)
        const last = sources[sources.length - 1];
        if (last.startsWith("/")) {
          // All args are remote paths, download to current dir
          remotePaths = sources;
          localDir = ".";
        } else {
          remotePaths = sources.slice(0, -1);
          localDir = last;
        }
      }

      const results: Array<{ remote_path: string; local_path: string; size: number }> = [];

      for (const remotePath of remotePaths) {
        const result = await downloadSingleFile(remotePath, localDir);
        results.push(result);
      }

      printSuccess(results.length === 1 ? results[0] : results);
    });
}
