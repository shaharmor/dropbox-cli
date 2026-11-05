import type { Command } from "commander";
import { realpathSync } from "fs";
import { logHuman } from "../lib/logger";
import { printError, printSuccess } from "../lib/output";
import {
  CURRENT_VERSION, RELEASES_URL, UpgradeError, assetName, isCompiledBinary, isNewer, latestRelease, replaceBinary,
} from "../lib/update";

export function registerUpgradeCommand(program: Command): void {
  program
    .command("upgrade")
    .description("Replace this dropbox-cli binary with the latest release")
    .addHelpText("after", `
Examples:
  $ dropbox-cli upgrade            Upgrade to the latest release
  $ dropbox-cli upgrade --human    Upgrade and show progress`)
    .action(async () => {
      const asset = assetName();
      if (!isCompiledBinary() || !asset) {
        printError("upgrade_unsupported",
          `upgrade only replaces an installed dropbox-cli binary on macOS or Linux. Download releases from ${RELEASES_URL}.`);
      }
      try {
        logHuman("Checking for the latest release...");
        const latest = await latestRelease();
        if (!isNewer(latest.version, CURRENT_VERSION)) {
          logHuman(`dropbox-cli ${CURRENT_VERSION} is up to date.`);
          printSuccess({ previous_version: CURRENT_VERSION, version: CURRENT_VERSION, updated: false });
          return;
        }
        logHuman(`Downloading dropbox-cli ${latest.version}...`);
        await replaceBinary(realpathSync(process.execPath), latest.tag, asset);
        logHuman(`Upgraded dropbox-cli ${CURRENT_VERSION} → ${latest.version}.`);
        printSuccess({ previous_version: CURRENT_VERSION, version: latest.version, updated: true });
      } catch (error) {
        if (error instanceof UpgradeError) printError(error.code, error.message);
        throw error;
      }
    });
}
