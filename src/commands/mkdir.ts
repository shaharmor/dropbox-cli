import type { Command } from "commander";
import { rpc } from "../lib/api";
import { printSuccess } from "../lib/output";
import { logHuman } from "../lib/logger";

export function registerMkdirCommand(program: Command): void {
  program
    .command("mkdir <path>")
    .description("Create a folder in Dropbox")
    .addHelpText("after", `
Examples:
  $ dropbox-cli mkdir /Projects/new-project    Create a new folder
  $ dropbox-cli mkdir /Photos/2024/January     Create nested folders`)
    .action(async (path: string) => {
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
