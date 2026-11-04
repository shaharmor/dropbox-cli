import type { Command } from "commander";
import { rpc } from "../lib/api";
import { machineRpc } from "../lib/machine-api";
import { printSuccess, formatBytes, formatDate, runMachine } from "../lib/output";
import { logHuman } from "../lib/logger";
import { MachineError, type ListFolderResult, type DropboxEntry, type MachineOptions } from "../types";

type LsOptions = MachineOptions & {
  limit?: string;
  recursive?: boolean;
  type?: string;
  page?: boolean;
  pageSize?: string;
  cursor?: string;
};

const DEFAULT_PAGE_SIZE = 128;
const MAX_PAGE_ENTRIES = 2000;

function isMachineListing(options: LsOptions): boolean {
  return !!options.page || options.expectedAccount !== undefined || options.cursor !== undefined ||
    options.pageSize !== undefined || options.timeout !== undefined;
}

function isValidPage(page: ListFolderResult | null): boolean {
  return !!page && Array.isArray(page.entries) && page.entries.length <= MAX_PAGE_ENTRIES &&
    typeof page.cursor === "string" && page.cursor.length > 0 && typeof page.has_more === "boolean";
}

/** Exactly one provider page per call: the first page of `path`, or the page after `--cursor`. */
function listPage(path: string, options: LsOptions): Promise<void> {
  return runMachine(options, async request => {
    const size = Number(options.pageSize ?? DEFAULT_PAGE_SIZE);
    const validArgs = options.page && !options.recursive && !options.limit && !options.type &&
      Number.isInteger(size) && size >= 1 && size <= MAX_PAGE_ENTRIES &&
      (options.cursor === undefined || (!!options.cursor && path === ""));
    if (!validArgs) {
      throw new MachineError("invalid_args", "Page mode requires nonrecursive unfiltered listing, a size of 1–2000, and either a path or cursor.");
    }

    const page = options.cursor
      ? await machineRpc<ListFolderResult>("files/list_folder/continue", { cursor: options.cursor }, request)
      : await machineRpc<ListFolderResult>("files/list_folder", {
        path: path === "/" ? "" : path,
        recursive: false,
        include_mounted_folders: true,
        include_non_downloadable_files: true,
        limit: size,
      }, request);
    if (!isValidPage(page)) throw new MachineError("invalid_response", "Invalid or oversized listing page.");
    return page;
  });
}

export function registerLsCommand(program: Command): void {
  program
    .command("ls [path]")
    .description("List files and folders in a Dropbox directory")
    .option("--limit <count>", "Maximum number of entries to return")
    .option("--recursive", "List files in all subdirectories")
    .option("--type <type>", "Filter by type: file or folder")
    .option("--page", "Machine mode: return one bounded nonrecursive page")
    .option("--page-size <count>", "Requested first-page size (1–2000; default 128)")
    .option("--cursor <cursor>", "Continue a machine listing")
    .option("--expected-account <id>", "Required account identity for machine mode")
    .option("--timeout <seconds>", "Machine request deadline (1–600 seconds)")
    .addHelpText("after", `
Examples:
  $ dropbox-cli ls                          List root directory
  $ dropbox-cli ls /Photos                  List a specific folder
  $ dropbox-cli ls /Documents --limit 10    Show first 10 entries
  $ dropbox-cli ls /Projects --recursive    List all files recursively
  $ dropbox-cli ls /Projects --type folder  Show only folders
  $ dropbox-cli ls /Projects --type file    Show only files`)
    .action(async (path: string = "", options: LsOptions) => {
      if (isMachineListing(options)) return listPage(path, options);
      if (options.limit && options.type) {
        throw new Error("--limit and --type cannot be used together");
      }

      // Dropbox uses "" for root, not "/"
      const dbxPath = path === "/" ? "" : path;
      const limit = options.limit ? parseInt(options.limit, 10) : undefined;

      // First page
      const listArgs: Record<string, unknown> = {
        path: dbxPath,
        recursive: options.recursive ?? false,
        include_mounted_folders: true,
        include_non_downloadable_files: true,
      };
      if (limit !== undefined) {
        listArgs.limit = Math.min(limit, 2000); // Dropbox max per page is 2000
      }

      let result = await rpc<ListFolderResult>("files/list_folder", listArgs);

      const allEntries: DropboxEntry[] = [...result.entries];

      // Auto-paginate (respect limit)
      while (result.has_more && (limit === undefined || allEntries.length < limit)) {
        result = await rpc<ListFolderResult>("files/list_folder/continue", {
          cursor: result.cursor,
        });
        allEntries.push(...result.entries);
      }

      // Filter by type if requested
      const filtered = options.type
        ? allEntries.filter((e) => e[".tag"] === options.type)
        : allEntries;

      // Trim to exact limit if we overshot
      const entries = limit !== undefined ? filtered.slice(0, limit) : filtered;

      if (entries.length === 0) {
        logHuman("(empty folder)\n");
      } else {
        // Print header
        logHuman(
          `${"Type".padEnd(8)}${"Name".padEnd(40)}${"Size".padStart(12)}  Modified`
        );
        logHuman("-".repeat(80));
        for (const entry of entries) {
          const type = entry[".tag"] === "folder" ? "folder" : "file";
          const size =
            entry[".tag"] === "file" ? formatBytes(entry.size) : "-";
          const modified =
            entry[".tag"] === "file"
              ? formatDate(entry.server_modified)
              : "-";
          logHuman(
            `${type.padEnd(8)}${entry.name.padEnd(40)}${size.padStart(12)}  ${modified}`
          );
        }
        logHuman(`\n${entries.length} items`);
      }

      printSuccess(entries);
    });
}
