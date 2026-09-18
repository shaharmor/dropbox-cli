import type { Command } from "commander";
import { rpc, machineMetadata, machineRpc, validateMetadata, exactPath, isNotFound } from "../lib/api";
import { printSuccess, runMachine } from "../lib/output";
import { MachineError, type MachineOptions } from "../types";
import { posix } from "path";
import { logHuman } from "../lib/logger";

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
    .action(async (path: string, options: MachineOptions & { safe?: boolean; parentId?: string }) => {
      if (Object.keys(options).length) return runMachine(options, async request => {
        if (!options.safe || !exactPath(path) || !options.parentId?.startsWith("id:")) throw new MachineError("invalid_args", "Safe mkdir requires an exact path and --parent-id.");
        const parent = await machineMetadata(posix.dirname(path).toLowerCase(), request);
        if (parent[".tag"] !== "folder" || parent.id !== options.parentId) throw new MachineError("folder_drift", "Parent folder identity changed.");
        const inspect = async () => {
          const metadata = await machineMetadata(path.toLowerCase(), request);
          if (metadata[".tag"] !== "folder") throw new MachineError("destination_conflict", "The destination exists but is not a folder.");
          return { created: false, metadata };
        };
        try { return await inspect(); } catch (error) { if (!isNotFound(error)) throw error; }
        let result: { metadata: unknown };
        try { result = await machineRpc("files/create_folder_v2", { path, autorename: false }, request); }
        catch (error) {
          if (error instanceof MachineError && error.details.outcome === "refused" && error.details.http_status === 409) {
            const data = error.details.dropbox as { ".tag"?: string; path?: { ".tag"?: string; conflict?: { ".tag"?: string } } };
            if (data?.[".tag"] === "path" && data.path?.[".tag"] === "conflict" && data.path.conflict?.[".tag"] === "folder") {
              // A failed verification read cannot replace the authoritative creation refusal.
              try { return await inspect(); } catch { throw error; }
            }
          }
          throw error;
        }
        try {
          // create_folder_v2 returns FolderMetadata, not the tagged Metadata union.
          const metadata = validateMetadata({ ".tag": "folder", ...(result?.metadata as Record<string, unknown>) });
          if (metadata[".tag"] !== "folder" || metadata.path_lower !== path.toLowerCase()) throw new Error();
          return { created: true, metadata };
        } catch { throw new MachineError("unknown_outcome", "Folder submission returned invalid metadata. Reconcile without replaying.", { outcome: "unknown" }); }
      });
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
