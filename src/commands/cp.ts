import type { Command } from "commander";
import { rpc, pollBatchJob } from "../lib/api";
import { printSuccess, printError } from "../lib/output";
import { logHuman } from "../lib/logger";
import type { DropboxEntry, BatchResult } from "../types";
import { basename } from "path";

export function registerCpCommand(program: Command): void {
  program
    .command("cp <sources...>")
    .description(
      "Copy file(s) in Dropbox. Last argument is the destination. " +
      "For multiple files, destination must be a directory."
    )
    .option("--autorename", "Automatically rename on conflict")
    .addHelpText("after", `
Examples:
  $ dropbox-cli cp /Documents/report.pdf /Backup/report.pdf    Copy a file
  $ dropbox-cli cp /a.txt /b.txt /c.txt /Backup               Copy multiple files to a folder
  $ dropbox-cli cp /file.txt /file-copy.txt --autorename       Auto-rename on conflict`)
    .action(async (sources: string[], options: { autorename?: boolean }) => {
      if (sources.length < 2) {
        printError("invalid_args", "Usage: dropbox-cli cp <source...> <destination>");
      }

      const dest = sources[sources.length - 1];
      const srcPaths = sources.slice(0, -1);
      const autorename = options.autorename ?? false;

      if (srcPaths.length === 1) {
        // Single file copy
        const result = await rpc<{ metadata: DropboxEntry }>("files/copy_v2", {
          from_path: srcPaths[0],
          to_path: dest,
          autorename,
        });

        logHuman(`Copied to: ${result.metadata.path_display}`);

        printSuccess(result.metadata);
      } else {
        // Batch copy
        const entries = srcPaths.map((src) => ({
          from_path: src,
          to_path: `${dest}/${basename(src)}`,
        }));

        const result = await rpc<BatchResult>("files/copy_batch_v2", {
          entries,
          autorename,
        });

        if (result[".tag"] === "async_job_id") {
          logHuman("Batch copy in progress...");
          const completed = await pollBatchJob<BatchResult>(
            "files/copy_batch/check_v2",
            result.async_job_id!
          );
          logHuman("Batch copy complete.");
          printSuccess(completed.entries);
        } else {
          logHuman("Batch copy complete.");
          printSuccess(result.entries);
        }
      }
    });
}
