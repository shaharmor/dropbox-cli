import type { Command } from "commander";
import { contentDownload } from "../lib/api";
import { printSuccess, formatBytes } from "../lib/output";
import { logHuman } from "../lib/logger";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { basename, join, dirname, resolve } from "path";

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
    .addHelpText("after", `
Examples:
  $ dropbox-cli download /Documents/report.pdf             Download to current directory
  $ dropbox-cli download /Documents/report.pdf ./local     Download to a specific directory
  $ dropbox-cli download /Photos/a.jpg /Photos/b.jpg .     Download multiple files`)
    .action(async (sources: string[]) => {
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
