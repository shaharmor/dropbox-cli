import type { Command } from "commander";
import { rpc } from "../lib/api";
import {
  exactPath, isFolderConflict, isId, isNotFound, machineMetadata, machineRpc, validateMetadata,
} from "../lib/machine-api";
import { printSuccess, runMachine } from "../lib/output";
import { MachineError, type MachineMetadata, type MachineOptions, type RequestOptions } from "../types";
import { posix } from "path";
import { logHuman } from "../lib/logger";

type MkdirOptions = MachineOptions & { safe?: boolean; parentId?: string };

/** The folder already at `path`. Throws not-found if vacant, or a conflict for a non-folder. */
async function existingFolder(path: string, request: RequestOptions) {
  const metadata = await machineMetadata(path.toLowerCase(), request);
  if (metadata[".tag"] !== "folder") {
    throw new MachineError("destination_conflict", "The destination exists but is not a folder.");
  }
  return { created: false, metadata };
}

function isFolderConflictRefusal(error: unknown): error is MachineError {
  return error instanceof MachineError && error.details.outcome === "refused" &&
    error.details.http_status === 409 && isFolderConflict(error.details.dropbox);
}

function createdFolder(value: unknown, path: string) {
  const unknownOutcome = () => new MachineError(
    "unknown_outcome",
    "Folder submission returned invalid metadata. Reconcile without replaying.",
    { outcome: "unknown" },
  );
  let metadata: MachineMetadata;
  try {
    // create_folder_v2 returns FolderMetadata, not the tagged Metadata union.
    metadata = validateMetadata({ ".tag": "folder", ...(value as Record<string, unknown>) });
  } catch {
    throw unknownOutcome();
  }
  if (metadata[".tag"] !== "folder" || metadata.path_lower !== path.toLowerCase()) throw unknownOutcome();
  return { created: true, metadata };
}

/** Ensures a folder exists at exactly `path` under the expected parent, never autorenaming. */
function ensureFolder(path: string, options: MkdirOptions): Promise<void> {
  return runMachine(options, async request => {
    if (!options.safe || !exactPath(path) || !isId(options.parentId)) {
      throw new MachineError("invalid_args", "Safe mkdir requires an exact path and --parent-id.");
    }
    const parent = await machineMetadata(posix.dirname(path).toLowerCase(), request);
    if (parent[".tag"] !== "folder" || parent.id !== options.parentId) {
      throw new MachineError("folder_drift", "Parent folder identity changed.");
    }

    try {
      return await existingFolder(path, request);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    let result: { metadata: unknown };
    try {
      result = await machineRpc("files/create_folder_v2", { path, autorename: false }, request);
    } catch (error) {
      if (!isFolderConflictRefusal(error)) throw error;
      // A failed verification read cannot replace the authoritative creation refusal.
      try {
        return await existingFolder(path, request);
      } catch {
        throw error;
      }
    }
    return createdFolder(result?.metadata, path);
  });
}

export function registerMkdirCommand(program: Command): void {
  program
    .command("mkdir <path>")
    .description("Create a folder in Dropbox")
    .option("--safe", "Machine mode: ensure the exact folder without autorename")
    .option("--parent-id <id>", "Expected parent folder identity")
    .option("--expected-account <id>", "Required account identity for machine mode")
    .option("--timeout <seconds>", "Machine request deadline (1–600 seconds)")
    .addHelpText("after", `
Examples:
  $ dropbox-cli mkdir /Projects/new-project    Create a new folder
  $ dropbox-cli mkdir /Photos/2024/January     Create nested folders`)
    .action(async (path: string, options: MkdirOptions) => {
      // Any machine flag routes to the checked path so an incomplete invocation fails closed.
      if (Object.keys(options).length) return ensureFolder(path, options);
      const result = await rpc<{ metadata: Record<string, unknown> }>(
        "files/create_folder_v2",
        {
          path,
          autorename: false,
        }
      );

      logHuman(`Created folder: ${(result.metadata as { path_display: string }).path_display}`);

      printSuccess(result.metadata);
    });
}
