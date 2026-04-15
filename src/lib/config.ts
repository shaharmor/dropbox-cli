import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { AppConfig, AuthData } from "../types";

function getConfigDir(): string {
  return process.env.DROPBOX_CLI_CONFIG_DIR || join(homedir(), ".dropbox-cli");
}

function ensureConfigDir(): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function readConfig(): AppConfig | null {
  const configFile = join(getConfigDir(), "config.json");
  if (!existsSync(configFile)) return null;
  return JSON.parse(readFileSync(configFile, "utf-8"));
}

export function writeConfig(config: AppConfig): void {
  ensureConfigDir();
  writeFileSync(join(getConfigDir(), "config.json"), JSON.stringify(config, null, 2));
}

export function readAuth(): AuthData | null {
  const authFile = join(getConfigDir(), "auth.json");
  if (!existsSync(authFile)) return null;
  return JSON.parse(readFileSync(authFile, "utf-8"));
}

export function writeAuth(auth: AuthData): void {
  ensureConfigDir();
  writeFileSync(join(getConfigDir(), "auth.json"), JSON.stringify(auth, null, 2));
}

export function clearAuth(): void {
  const authFile = join(getConfigDir(), "auth.json");
  if (existsSync(authFile)) {
    unlinkSync(authFile);
  }
}
