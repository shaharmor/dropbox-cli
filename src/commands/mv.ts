import type { Command } from "commander";
import { rpc, pollBatchJob } from "../lib/api";
import { exactPath, isContentHash, isId, machineMetadata, machineRpc, pathExists, validateMetadata } from "../lib/machine-api";
import { printSuccess, printError, runMachine } from "../lib/output";
import { logHuman } from "../lib/logger";
import { MachineError, type DropboxEntry, type BatchResult, type MachineMetadata, type MachineOptions } from "../types";
import { basename, posix } from "path";

interface SafeMoveOptions extends MachineOptions {
  safe?: boolean;
  autorename?: boolean;
  expectedRev?: string;
  expectedSourcePath?: string;
  sourceParentId?: string;
  destinationParentId?: string;
}

type CheckedMoveOptions = SafeMoveOptions & {
  expectedRev: string;
  expectedSourcePath: string;
  sourceParentId: string;
  destinationParentId: string;
};

function isCheckedMove(sources: string[], options: SafeMoveOptions): options is CheckedMoveOptions {
  const [source, destination] = sources;
  return !!options.safe && !options.autorename && sources.length === 2 &&
    isId(source) && !!destination && exactPath(destination) &&
    !!options.expectedRev && !!options.expectedSourcePath && exactPath(options.expectedSourcePath) &&
    isId(options.sourceParentId) && isId(options.destinationParentId);
}

/** Dropbox may assign a new revision when it moves a file; an equal content hash proves the bytes are unchanged. */
function hasSameContent(moved: MachineMetadata, original: MachineMetadata): boolean {
  if (moved.size !== original.size) return false;
  if (original.content_hash === undefined) return moved.rev === original.rev;
  return isContentHash(original.content_hash) && moved.content_hash === original.content_hash;
}

function confirmMove(value: unknown, original: MachineMetadata, source: string, destination: string) {
  const unknownOutcome = () => new MachineError(
    "unknown_outcome",
    "Submission returned mismatching metadata. Reconcile without replaying.",
    { outcome: "unknown" },
  );
  let moved: MachineMetadata;
  try {
    moved = validateMetadata(value);
  } catch {
    throw unknownOutcome();
  }
  const confirmed = moved[".tag"] === "file" && moved.id === source &&
    moved.path_lower === destination.toLowerCase() && hasSameContent(moved, original);
  if (!confirmed) throw unknownOutcome();
  return { outcome: "confirmed", metadata: moved };
}

/** Moves one reviewed file by ID after verifying the source, both folders and a vacant destination. */
async function safeMove(sources: string[], options: SafeMoveOptions): Promise<void> {
  return runMachine(options, async request => {
    if (!isCheckedMove(sources, options)) {
      throw new MachineError("invalid_args", "Safe move requires one ID source, exact destination, expected revision/location and both parent IDs; autorename is forbidden.");
    }
    const [source, destination] = sources as [string, string];

    const original = await machineMetadata(source, request);
    if (original[".tag"] !== "file" || original.rev !== options.expectedRev ||
        original.path_lower !== options.expectedSourcePath.toLowerCase()) {
      throw new MachineError("source_drift", "Source identity, revision or location changed before submission.");
    }

    const sourceFolder = await machineMetadata(options.sourceParentId, request);
    const destinationFolder = await machineMetadata(posix.dirname(destination).toLowerCase(), request);
    if (sourceFolder[".tag"] !== "folder" || sourceFolder.path_lower !== posix.dirname(original.path_lower) ||
        destinationFolder[".tag"] !== "folder" || destinationFolder.id !== options.destinationParentId) {
      throw new MachineError("folder_drift", "Source or destination folder identity/location changed.");
    }

    if (await pathExists(destination, request)) {
      throw new MachineError("destination_conflict", "The exact destination already exists; nothing was moved.");
    }

    // Sharing is informational by explicit owner policy. No sharing API or permission changes.
    const result = await machineRpc<{ metadata: unknown }>("files/move_v2", {
      from_path: source, to_path: destination, autorename: false, allow_ownership_transfer: false,
    }, request);
    return confirmMove(result?.metadata, original, source, destination);
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
      // Any machine flag routes to the checked path, so an incomplete safe invocation
      // fails with invalid_args instead of silently running an unchecked move.
      const machineMode = Object.keys(options).some(key => key !== "autorename");
      if (machineMode) return safeMove(sources, options);
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
