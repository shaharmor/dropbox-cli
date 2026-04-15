import type { Command } from "commander";
import { rpc, rpcRaw } from "../lib/api";
import { printSuccess, printError, isHuman } from "../lib/output";
import { logError } from "../lib/logger";
import type { SharedLinkMetadata } from "../types";

export function registerShareCommand(program: Command): void {
  program
    .command("share <path>")
    .description("Create a shared link for a file or folder")
    .addHelpText("after", `
Examples:
  $ dropbox-cli share /Documents/report.pdf    Get a shareable link for a file
  $ dropbox-cli share /Photos/Vacation         Get a shareable link for a folder`)
    .action(async (path: string) => {
      const result = await rpcRaw("sharing/create_shared_link_with_settings", {
        path,
        settings: {
          requested_visibility: { ".tag": "public" },
          audience: { ".tag": "public" },
          access: { ".tag": "viewer" },
        },
      });

      if (result.ok) {
        const link = result.data as SharedLinkMetadata;
        if (isHuman()) {
          logError(`Shared link: ${link.url}`);
        }
        printSuccess(link);
        return;
      }

      // Check if link already exists
      const errorData = result.data as { error?: { ".tag"?: string } };
      if (errorData?.error?.[".tag"] === "shared_link_already_exists") {
        const existing = await rpc<{ links: SharedLinkMetadata[] }>(
          "sharing/list_shared_links",
          { path, direct_only: true }
        );

        if (existing.links.length > 0) {
          if (isHuman()) {
            logError(`Existing shared link: ${existing.links[0].url}`);
          }
          printSuccess(existing.links[0]);
          return;
        }
      }

      const errorSummary = (result.data as { error_summary?: string })?.error_summary;
      printError("share_error", errorSummary || "Failed to create shared link");
    });
}
