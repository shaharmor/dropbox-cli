import type { Command } from "commander";
import { rpc, pollBatchJob, machineMetadata, machineRpc, validateMetadata, exactPath, isNotFound } from "../lib/api";
import { printSuccess, printError, runMachine } from "../lib/output";
import { logHuman } from "../lib/logger";
import { MachineError, type DropboxEntry, type BatchResult, type MachineOptions } from "../types";
import { basename, posix } from "path";

interface SafeMoveOptions extends MachineOptions {
  safe?: boolean;
  autorename?: boolean;
  expectedRev?: string;
  expectedSourcePath?: string;
  sourceParentId?: string;
  destinationParentId?: string;
}

async function safeMove(sources: string[], options: SafeMoveOptions): Promise<void> {
  return runMachine(options, async request => {
    const [source, destination] = sources;
    if (!options.safe || options.autorename || sources.length !== 2 || !source?.startsWith("id:") || source.length <= 3 ||
        !destination || !exactPath(destination) || !options.expectedRev || !options.expectedSourcePath || !exactPath(options.expectedSourcePath) ||
        !options.sourceParentId?.startsWith("id:") || !options.destinationParentId?.startsWith("id:")) {
      throw new MachineError("invalid_args", "Safe move requires one ID source, exact destination, expected revision/location and both parent IDs; autorename is forbidden.");
    }
    const original = await machineMetadata(source, request);
    if (original[".tag"] !== "file" || original.rev !== options.expectedRev || original.path_lower !== options.expectedSourcePath.toLowerCase()) {
      throw new MachineError("source_drift", "Source identity, revision or location changed before submission.");
    }
    const from = await machineMetadata(options.sourceParentId, request);
    const to = await machineMetadata(posix.dirname(destination).toLowerCase(), request);
    if (from[".tag"] !== "folder" || from.path_lower !== posix.dirname(original.path_lower) ||
        to[".tag"] !== "folder" || to.id !== options.destinationParentId) {
      throw new MachineError("folder_drift", "Source or destination folder identity/location changed.");
    }
    try {
      await machineMetadata(destination.toLowerCase(), request);
      throw new MachineError("destination_conflict", "The exact destination already exists; nothing was moved.");
    } catch (error) { if (!isNotFound(error)) throw error; }
    // Sharing is informational by explicit owner policy. No sharing API or permission changes.
    const result = await machineRpc<{ metadata: unknown }>("files/move_v2", {
      from_path: source, to_path: destination, autorename: false, allow_ownership_transfer: false,
    }, request);
    try {
      const moved = validateMetadata(result?.metadata);
      if (moved[".tag"] !== "file" || moved.id !== source || moved.rev !== options.expectedRev || moved.path_lower !== destination.toLowerCase()) throw new Error();
      return { outcome: "confirmed", metadata: moved };
    } catch {
      throw new MachineError("unknown_outcome", "Submission returned mismatching metadata. Reconcile without replaying.", { outcome: "unknown" });
    }
  });
}

export function registerMvCommand(program: Command): void {
  program
    .command("mv <sources...>")
    .description(
      "Move/rename file(s) in Dropbox. Last argument is the destination. " +
      "For multiple files, destination must be a directory."
    )
    .option("--autorename", "Automatically rename on conflict")
    .option("--safe", "Machine mode: checked, single ID-addressed submission")
    .option("--expected-account <id>", "Required account identity for safe move")
    .option("--expected-rev <rev>", "Reviewed source revision")
    .option("--expected-source-path <path>", "Recorded source location")
    .option("--source-parent-id <id>", "Recorded source folder identity")
    .option("--destination-parent-id <id>", "Recorded destination folder identity")
    .option("--timeout <seconds>", "Machine request deadline (1–600 seconds)")
    .addHelpText("after", `
Examples:
  $ dropbox-cli mv /old-name.txt /new-name.txt              Rename a file
  $ dropbox-cli mv /Documents/file.txt /Archive/file.txt    Move a file to another folder
  $ dropbox-cli mv /a.txt /b.txt /c.txt /Archive            Move multiple files to a folder`)
    .action(async (sources: string[], options: SafeMoveOptions) => {
      if (options.safe || Object.keys(options).some(key => key !== "autorename")) return safeMove(sources, options);
      if (sources.length < 2) {
        printError("invalid_args", "Usage: dropbox-cli mv <source...> <destination>");
      }

      const dest = sources[sources.length - 1];
      const srcPaths = sources.slice(0, -1);
      const autorename = options.autorename ?? false;

      if (srcPaths.length === 1) {
        // Single file move
        const result = await rpc<{ metadata: DropboxEntry }>("files/move_v2", {
          from_path: srcPaths[0],
          to_path: dest,
          autorename,
          allow_ownership_transfer: false,
        });

        logHuman(`Moved to: ${result.metadata.path_display}`);

        printSuccess(result.metadata);
      } else {
        // Batch move
        const entries = srcPaths.map((src) => ({
          from_path: src,
          to_path: `${dest}/${basename(src)}`,
        }));

        const result = await rpc<BatchResult>("files/move_batch_v2", {
          entries,
          autorename,
          allow_ownership_transfer: false,
        });

        if (result[".tag"] === "async_job_id") {
          // Poll for completion
          logHuman("Batch move in progress...");
          const completed = await pollBatchJob<BatchResult>(
            "files/move_batch/check_v2",
            result.async_job_id!
          );
          logHuman("Batch move complete.");
          printSuccess(completed.entries);
        } else {
          logHuman("Batch move complete.");
          printSuccess(result.entries);
        }
      }
    });
}
