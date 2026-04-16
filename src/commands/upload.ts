import type { Command } from "commander";
import { contentUpload } from "../lib/api";
import { printSuccess, printError, formatBytes } from "../lib/output";
import { log, logHuman } from "../lib/logger";
import { statSync, readFileSync } from "fs";
import { basename, resolve } from "path";
import type { FileMetadata } from "../types";

const SINGLE_UPLOAD_LIMIT = 150 * 1024 * 1024; // 150MB
const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB chunks

type WriteMode = { ".tag": "add" } | { ".tag": "update"; update: string } | { ".tag": "overwrite" };

async function uploadSingleFile(
  localPath: string,
  remotePath: string,
  autorename: boolean
): Promise<FileMetadata> {
  const absolutePath = resolve(localPath);
  const stat = statSync(absolutePath);
  const content = readFileSync(absolutePath);

  logHuman(`Uploading ${basename(localPath)} (${formatBytes(stat.size)})...`);

  if (stat.size <= SINGLE_UPLOAD_LIMIT) {
    return contentUpload<FileMetadata>("files/upload", {
      path: remotePath,
      mode: { ".tag": "add" } as WriteMode,
      autorename,
      mute: false,
      strict_conflict: !autorename,
    }, content);
  }

  // Chunked upload for large files
  return chunkedUpload(content, remotePath, autorename);
}

async function chunkedUpload(
  content: Buffer,
  remotePath: string,
  autorename: boolean
): Promise<FileMetadata> {
  const totalSize = content.length;
  let offset = 0;

  // Start session
  const startResult = await contentUpload<{ session_id: string }>(
    "files/upload_session/start",
    { close: false },
    content.subarray(0, CHUNK_SIZE)
  );
  offset = CHUNK_SIZE;
  log(`Upload session started: ${startResult.session_id}`);

  // Append chunks
  while (offset + CHUNK_SIZE < totalSize) {
    const chunk = content.subarray(offset, offset + CHUNK_SIZE);
    await contentUpload("files/upload_session/append_v2", {
      cursor: { session_id: startResult.session_id, offset },
      close: false,
    }, chunk);
    offset += CHUNK_SIZE;

    const pct = Math.round((offset / totalSize) * 100);
    logHuman(`  Progress: ${pct}% (${formatBytes(offset)} / ${formatBytes(totalSize)})`);
  }

  // Finish with last chunk
  const lastChunk = content.subarray(offset);
  return contentUpload<FileMetadata>("files/upload_session/finish", {
    cursor: { session_id: startResult.session_id, offset },
    commit: {
      path: remotePath,
      mode: { ".tag": "add" } as WriteMode,
      autorename,
      mute: false,
      strict_conflict: !autorename,
    },
  }, lastChunk);
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
        printError("invalid_args", "Usage: dropbox-cli upload <local-file...> <remote-path>");
      }

      const remoteDest = sources[sources.length - 1];
      const localFiles = sources.slice(0, -1);
      const autorename = options.autorename ?? false;

      const results: FileMetadata[] = [];

      for (const localFile of localFiles) {
        // If uploading multiple files, treat remoteDest as a directory
        const remotePath =
          localFiles.length > 1
            ? `${remoteDest}/${basename(localFile)}`
            : remoteDest;

        const result = await uploadSingleFile(localFile, remotePath, autorename);
        results.push(result);

        logHuman(`  Uploaded to: ${result.path_display}`);
      }

      printSuccess(localFiles.length === 1 ? results[0] : results);
    });
}
