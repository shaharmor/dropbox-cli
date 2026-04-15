import type { Command } from "commander";
import { rpc } from "../lib/api";
import { printSuccess, isHuman } from "../lib/output";
import { logError } from "../lib/logger";

export function registerMkdirCommand(program: Command): void {
  program
    .command("mkdir <path>")
    .description("Create a folder in Dropbox")
    .action(async (path: string) => {
      const result = await rpc<{ metadata: Record<string, unknown> }>(
        "files/create_folder_v2",
        {
          path,
          autorename: false,
        }
      );

      if (isHuman()) {
        logError(`Created folder: ${(result.metadata as { path_display: string }).path_display}`);
      }

      printSuccess(result.metadata);
    });
}
