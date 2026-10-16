import type { Command } from "commander";
import { contentDownload, machineDownload, waitForRequest } from "../lib/api";
import { printSuccess, formatBytes, runMachine } from "../lib/output";
import { MachineError, type MachineOptions } from "../types";
import { constants } from "fs";
import { open, lstat, link, unlink } from "fs/promises";
import { createHash, randomUUID } from "crypto";
import { logHuman } from "../lib/logger";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { basename, join, dirname, resolve, isAbsolute, parse } from "path";

interface OutputOptions extends MachineOptions {
  outputFile?: string;
  expectedId?: string;
  expectedHash?: string;
  progress?: boolean;
}

async function checkOutput(path: string): Promise<void> {
  // Standard filesystem safety, not protection against concurrent same-user ancestor swaps.
  let current = parse(path).root;
  for (const part of dirname(path).slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new MachineError("unsafe_output", "Output ancestors must be existing nonsymlink directories.");
  }
  try {
    const stat = await lstat(path);
    throw new MachineError(stat.isSymbolicLink() ? "unsafe_output" : "output_exists", "Output already exists; it will not be replaced.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

async function downloadOriginal(sources: string[], options: OutputOptions): Promise<void> {
  return runMachine(options, async request => {
    const source = sources[0], output = options.outputFile;
    if (sources.length !== 1 || !source?.startsWith("rev:") || source.length <= 4 || !options.expectedId?.startsWith("id:") ||
        !output || !isAbsolute(output) || output.includes("\0") || resolve(output) !== output ||
        (options.expectedHash !== undefined && !/^[a-f0-9]{64}$/.test(options.expectedHash))) {
      throw new MachineError("invalid_args", "Original download requires one rev: source, --expected-id and an absolute normalized --output-file.");
    }
    let stage: string | undefined;
    let file: Awaited<ReturnType<typeof open>> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await checkOutput(output);
      stage = join(dirname(output), `.dropbox-${randomUUID()}.part`);
      file = await open(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const download = await machineDownload(source, request);
      reader = download.body.getReader();
      const meta = download.metadata;
      if (meta.id !== options.expectedId || meta.rev !== source.slice(4) || !Number.isSafeInteger(meta.size) || (meta.size as number) < 0 ||
          (meta.content_hash !== undefined && (typeof meta.content_hash !== "string" || !/^[a-f0-9]{64}$/.test(meta.content_hash))) ||
          (options.expectedHash !== undefined && meta.content_hash !== options.expectedHash)) {
        throw new MachineError("identity_mismatch", "Download metadata does not match the recorded identity/version/hash.");
      }
      const blockSize = 4 * 1024 * 1024;
      let total = 0, blockBytes = 0, block = createHash("sha256");
      let lastProgress = -Infinity;
      const reportProgress = (force = false) => {
        const now = performance.now();
        if (!options.progress || (!force && now - lastProgress < 100)) return;
        process.stderr.write(JSON.stringify({type: "download_progress", downloaded_bytes: total, total_bytes: meta.size}) + "\n");
        lastProgress = now;
      };
      reportProgress();
      const hash = createHash("sha256");
      while (true) {
        const { done, value } = await waitForRequest(reader.read(), request.signal);
        if (done) break;
        total += value.length;
        if (total > (meta.size as number)) throw new MachineError("integrity_error", "Download exceeded the declared size.");
        for (let offset = 0; offset < value.length;) {
          const count = Math.min(blockSize - blockBytes, value.length - offset);
          block.update(value.subarray(offset, offset + count));
          blockBytes += count; offset += count;
          if (blockBytes === blockSize) { hash.update(block.digest()); block = createHash("sha256"); blockBytes = 0; }
        }
        for (let offset = 0; offset < value.length;) {
          request.signal?.throwIfAborted();
          const written = await file.write(value, offset, value.length - offset);
          if (!written.bytesWritten) throw new MachineError("local_io_error", "Unable to write the staging file.");
          offset += written.bytesWritten;
        }
        reportProgress();
      }
      reportProgress(true);
      if (blockBytes) hash.update(block.digest());
      const actualHash = hash.digest("hex");
      if (total !== meta.size || (meta.content_hash !== undefined && meta.content_hash !== actualHash)) throw new MachineError("integrity_error", "Download size or Dropbox content hash did not match.");
      await file.sync(); await file.close(); file = undefined;
      await checkOutput(output);
      request.signal?.throwIfAborted();
      // Hard-link publication is atomic and fails if any object already occupies output.
      await link(stage, output);
      await unlink(stage); stage = undefined;
      return { id: meta.id, rev: meta.rev, content_hash: meta.content_hash, size: total, local_path: output };
    } catch (error) {
      if (error instanceof MachineError) throw error;
      if ((error as Error)?.name === "CredentialError") throw error;
      throw new MachineError(request.signal?.aborted ? "cancelled" : "download_error", "Original download was not completed; no partial file is published.");
    } finally {
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
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
