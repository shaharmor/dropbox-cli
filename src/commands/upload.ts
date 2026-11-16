import type { Command } from "commander";
import { contentUpload, contentUploadRaw, type RawResult } from "../lib/api";
import { printSuccess, formatBytes } from "../lib/output";
import { log, logHuman } from "../lib/logger";
import { responseError } from "../lib/transport";
import { statSync } from "fs";
import { basename, posix, resolve } from "path";
import { CommandError, type FileMetadata } from "../types";

// Every request body is at most one chunk, so memory stays near one chunk whatever the file size.
const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB chunks
// Re-sends of one chunk after its response was lost; 429/5xx retries happen in the transport.
const MAX_LOST_RESPONSES = 3;

type WriteMode = { ".tag": "add" } | { ".tag": "update"; update: string } | { ".tag": "overwrite" };

async function uploadSingleFile(
  localPath: string,
  remotePath: string,
  autorename: boolean
): Promise<FileMetadata> {
  const absolutePath = resolve(localPath);
  const stat = statSync(absolutePath);
  if (!stat.isFile()) throw new CommandError("invalid_args", `Not a file: ${localPath}`);
  // Pin the upload to the size reported above, read lazily from disk one slice at a time.
  const file = Bun.file(absolutePath).slice(0, stat.size);

  logHuman(`Uploading ${basename(localPath)} (${formatBytes(stat.size)})...`);

  const commit = {
    path: remotePath,
    mode: { ".tag": "add" } as WriteMode,
    autorename,
    mute: false,
    strict_conflict: !autorename,
  };

  if (stat.size <= CHUNK_SIZE) {
    return contentUpload<FileMetadata>("files/upload", commit, file);
  }

  return chunkedUpload(file, remotePath, commit);
}

async function chunkedUpload(
  file: Blob,
  remotePath: string,
  commit: Record<string, unknown>
): Promise<FileMetadata> {
  const totalSize = file.size;

  // A replayed start only leaves an unused session behind, so it may retry like a read.
  const startResult = await contentUpload<{ session_id: string }>(
    "files/upload_session/start",
    { close: false },
    file.slice(0, CHUNK_SIZE),
    { retry: "read" }
  );
  let offset = CHUNK_SIZE;
  log(`Upload session started: ${startResult.session_id}`);

  while (totalSize - offset > CHUNK_SIZE) {
    offset = await appendChunk(file, startResult.session_id, offset);

    const pct = Math.round((offset / totalSize) * 100);
    logHuman(`  Progress: ${pct}% (${formatBytes(offset)} / ${formatBytes(totalSize)})`);
  }

  // The commit is sent once: a lost response cannot prove the file was not created.
  try {
    return await contentUpload<FileMetadata>("files/upload_session/finish", {
      cursor: { session_id: startResult.session_id, offset },
      commit,
    }, file.slice(offset));
  } catch (error) {
    if (error instanceof CommandError && error.code === "connection_error") {
      throw new CommandError(
        "unknown_outcome",
        `The upload to ${remotePath} may have completed, but Dropbox's response was lost. Check the destination before uploading again.`
      );
    }
    throw error;
  }
}

/** Appends the chunk at `offset` and returns the offset Dropbox has accepted up to. */
async function appendChunk(file: Blob, sessionId: string, offset: number): Promise<number> {
  const chunk = file.slice(offset, offset + CHUNK_SIZE);
  for (let lost = 0; ; lost++) {
    let result: RawResult;
    try {
      // Appending at a fixed offset is replay-safe: Dropbox refuses a duplicate with incorrect_offset.
      result = await contentUploadRaw("files/upload_session/append_v2", {
        cursor: { session_id: sessionId, offset },
        close: false,
      }, chunk, { retry: "read" });
    } catch (error) {
      if (!(error instanceof CommandError && error.code === "connection_error") || lost >= MAX_LOST_RESPONSES) throw error;
      log(`Upload chunk at offset ${offset} was lost, re-sending`);
      await Bun.sleep(2 ** lost * 1000);
      continue;
    }

    if (result.ok) return offset + chunk.size;

    const error = (result.data as { error?: { ".tag"?: unknown; correct_offset?: unknown } } | null)?.error;
    if (result.status === 409 && error?.[".tag"] === "incorrect_offset") {
      // Dropbox already holds the bytes up to correct_offset, e.g. after an append whose response was lost.
      const correct = error.correct_offset;
      if (typeof correct === "number" && correct > offset && correct <= file.size) return correct;
      throw new CommandError("incorrect_offset", `Dropbox expected upload offset ${String(correct)}, which does not follow offset ${offset}.`);
    }

    throw responseError(result.status, result.data);
  }
}

export function registerUploadCommand(program: Command): void {
  program
    .command("upload <sources...>")
    .description(
      "Upload file(s) to Dropbox. Last argument is the remote path. " +
      "For multiple files, the remote path must be a directory."
    )
    .option("--autorename", "Automatically rename on conflict")
    .addHelpText("after", `
Examples:
  $ dropbox-cli upload ./report.pdf /Documents/report.pdf    Upload a single file
  $ dropbox-cli upload ./a.txt ./b.txt /Documents            Upload multiple files to a folder
  $ dropbox-cli upload ./photo.jpg /Photos/pic.jpg --autorename    Auto-rename on conflict`)
    .action(async (sources: string[], options: { autorename?: boolean }) => {
      if (sources.length < 2) {
        throw new CommandError("invalid_args", "Usage: dropbox-cli upload <local-file...> <remote-path>");
      }

      const remoteDest = sources[sources.length - 1];
      const localFiles = sources.slice(0, -1);
      const autorename = options.autorename ?? false;

      const results: FileMetadata[] = [];

      for (const localFile of localFiles) {
        // If uploading multiple files, treat remoteDest as a directory
        const remotePath =
          localFiles.length > 1
            ? posix.join(remoteDest, basename(localFile))
            : remoteDest;

        const result = await uploadSingleFile(localFile, remotePath, autorename);
        results.push(result);

        logHuman(`  Uploaded to: ${result.path_display}`);
      }

      printSuccess(localFiles.length === 1 ? results[0] : results);
    });
}
