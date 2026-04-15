# Dropbox CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone CLI for the Dropbox HTTP API that outputs JSON by default and compiles to a single binary via Bun.

**Architecture:** Commander.js registers flat subcommands (ls, upload, download, etc.). Each command calls the Dropbox API through a shared HTTP client that handles auth headers, token refresh, and rate limiting. Config and tokens live in `~/.dropbox-cli/`. No destructive operations (no delete, no overwrite) in v1.

**Tech Stack:** TypeScript, Bun (runtime + compiler), Commander.js

**Spec:** `docs/superpowers/specs/2026-04-15-dropbox-cli-design.md`

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/types.ts`

- [ ] **Step 1: Initialize project**

```bash
cd /Users/shaharmor/Documents/code/shaharmor/dropbox-cli
bun init -y
```

- [ ] **Step 2: Install dependencies**

```bash
bun add commander
bun add -d @types/node typescript
```

- [ ] **Step 3: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["bun-types"]
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Write src/types.ts**

```typescript
export interface AppConfig {
  client_id: string;
  client_secret: string;
}

export interface AuthData {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  account_id: string;
  account_email: string;
}

export interface DropboxFile {
  ".tag": "file";
  name: string;
  path_lower: string;
  path_display: string;
  id: string;
  size: number;
  is_downloadable: boolean;
  client_modified: string;
  server_modified: string;
  rev: string;
  content_hash: string;
}

export interface DropboxFolder {
  ".tag": "folder";
  name: string;
  path_lower: string;
  path_display: string;
  id: string;
}

export type DropboxEntry = DropboxFile | DropboxFolder;

export interface ListFolderResult {
  entries: DropboxEntry[];
  cursor: string;
  has_more: boolean;
}

export interface FileMetadata {
  ".tag": "file";
  name: string;
  path_lower: string;
  path_display: string;
  id: string;
  size: number;
  is_downloadable: boolean;
  client_modified: string;
  server_modified: string;
  rev: string;
  content_hash: string;
}

export interface FolderMetadata {
  ".tag": "folder";
  name: string;
  path_lower: string;
  path_display: string;
  id: string;
}

export interface SearchMatch {
  metadata: {
    metadata: DropboxEntry;
  };
}

export interface SearchResult {
  matches: SearchMatch[];
  has_more: boolean;
  cursor?: string;
}

export interface SharedLinkMetadata {
  url: string;
  name: string;
  path_lower: string;
  link_permissions: {
    resolved_visibility: { ".tag": string };
  };
}

export interface BatchResult {
  ".tag": "complete" | "async_job_id";
  entries?: Array<{
    ".tag": "success" | "failure";
    success?: DropboxEntry;
    failure?: { ".tag": string; [key: string]: unknown };
  }>;
  async_job_id?: string;
}
```

- [ ] **Step 5: Create directory structure**

```bash
mkdir -p src/commands src/lib
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: project scaffolding with types"
```

---

## Task 2: Config Module

**Files:**
- Create: `src/lib/config.ts`
- Create: `tests/lib/config.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// tests/lib/config.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readConfig, writeConfig, readAuth, writeAuth, clearAuth } from "../../src/lib/config";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

// Use a temp dir for tests
const TEST_DIR = join(import.meta.dir, ".test-config");

describe("config", () => {
  beforeEach(() => {
    // Override CONFIG_DIR for tests
    process.env.DROPBOX_CLI_CONFIG_DIR = TEST_DIR;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    delete process.env.DROPBOX_CLI_CONFIG_DIR;
  });

  test("readConfig returns null when no config exists", () => {
    expect(readConfig()).toBeNull();
  });

  test("writeConfig creates config dir and file", () => {
    writeConfig({ client_id: "test_id", client_secret: "test_secret" });
    const config = readConfig();
    expect(config).toEqual({ client_id: "test_id", client_secret: "test_secret" });
  });

  test("readAuth returns null when no auth exists", () => {
    expect(readAuth()).toBeNull();
  });

  test("writeAuth and readAuth round-trip", () => {
    const auth = {
      access_token: "tok",
      refresh_token: "ref",
      expires_at: 1234567890,
      account_id: "acc",
      account_email: "user@test.com",
    };
    writeAuth(auth);
    expect(readAuth()).toEqual(auth);
  });

  test("clearAuth removes auth file", () => {
    writeAuth({
      access_token: "tok",
      refresh_token: "ref",
      expires_at: 0,
      account_id: "acc",
      account_email: "a@b.com",
    });
    expect(readAuth()).not.toBeNull();
    clearAuth();
    expect(readAuth()).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/lib/config.test.ts
```

Expected: FAIL — module `../../src/lib/config` does not exist.

- [ ] **Step 3: Write src/lib/config.ts**

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/lib/config.test.ts
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/config.ts tests/lib/config.test.ts
git commit -m "feat: config module with read/write for app credentials and auth tokens"
```

---

## Task 3: Logger & Output Modules

**Files:**
- Create: `src/lib/logger.ts`
- Create: `src/lib/output.ts`
- Create: `tests/lib/output.test.ts`

- [ ] **Step 1: Write the output test file**

```typescript
// tests/lib/output.test.ts
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { formatSuccess, formatError, setHumanMode, isHuman } from "../../src/lib/output";

describe("output", () => {
  test("formatSuccess wraps data in ok envelope", () => {
    const result = formatSuccess({ name: "test.txt" });
    expect(result).toEqual({ ok: true, data: { name: "test.txt" } });
  });

  test("formatError wraps code and message", () => {
    const result = formatError("not_found", "File not found");
    expect(result).toEqual({
      ok: false,
      error: { code: "not_found", message: "File not found" },
    });
  });

  test("human mode toggle", () => {
    expect(isHuman()).toBe(false);
    setHumanMode(true);
    expect(isHuman()).toBe(true);
    setHumanMode(false);
    expect(isHuman()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/lib/output.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Write src/lib/output.ts**

```typescript
let humanMode = false;

export function setHumanMode(value: boolean): void {
  humanMode = value;
}

export function isHuman(): boolean {
  return humanMode;
}

export interface SuccessEnvelope<T = unknown> {
  ok: true;
  data: T;
}

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export function formatSuccess<T>(data: T): SuccessEnvelope<T> {
  return { ok: true, data };
}

export function formatError(code: string, message: string): ErrorEnvelope {
  return { ok: false, error: { code, message } };
}

export function printSuccess<T>(data: T): void {
  console.log(JSON.stringify(formatSuccess(data), null, 2));
}

export function printError(code: string, message: string, exitCode = 1): never {
  console.log(JSON.stringify(formatError(code, message), null, 2));
  process.exit(exitCode);
}

export function printAuthError(message: string): never {
  printError("auth_error", message, 2);
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}
```

- [ ] **Step 4: Write src/lib/logger.ts**

```typescript
let verbose = false;

export function setVerbose(value: boolean): void {
  verbose = value;
}

export function log(...args: unknown[]): void {
  if (verbose) {
    console.error("[verbose]", ...args);
  }
}

export function logError(...args: unknown[]): void {
  console.error(...args);
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test tests/lib/output.test.ts
```

Expected: all 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/logger.ts src/lib/output.ts tests/lib/output.test.ts
git commit -m "feat: logger and output formatting modules"
```

---

## Task 4: API Client

**Files:**
- Create: `src/lib/api.ts`

- [ ] **Step 1: Write src/lib/api.ts**

```typescript
import { readConfig, readAuth, writeAuth } from "./config";
import { log } from "./logger";
import { printError, printAuthError } from "./output";
import type { AuthData } from "../types";

const RPC_BASE = "https://api.dropboxapi.com/2";
const CONTENT_BASE = "https://content.dropboxapi.com/2";

async function getValidAuth(): Promise<AuthData> {
  const auth = readAuth();
  if (!auth) {
    printAuthError("Not authenticated. Run `dropbox-cli auth login` first.");
  }

  // Refresh if token expires within 5 minutes
  if (auth.expires_at && Date.now() / 1000 > auth.expires_at - 300) {
    await refreshToken(auth);
    return readAuth()!;
  }

  return auth;
}

async function refreshToken(auth: AuthData): Promise<void> {
  const config = readConfig();
  if (!config) {
    printAuthError("No app credentials found. Run `dropbox-cli auth login` first.");
  }

  log("Refreshing access token...");

  const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.refresh_token,
      client_id: config.client_id,
      client_secret: config.client_secret,
    }),
  });

  if (!response.ok) {
    printAuthError("Token refresh failed. Run `dropbox-cli auth login` to re-authenticate.");
  }

  const data = await response.json() as { access_token: string; expires_in: number };
  auth.access_token = data.access_token;
  auth.expires_at = Math.floor(Date.now() / 1000) + data.expires_in;
  writeAuth(auth);
  log("Token refreshed successfully");
}

async function fetchWithRetry(url: string, options: RequestInit, retryCount = 0): Promise<Response> {
  log(`POST ${url}`);
  const response = await fetch(url, options);
  log(`Response: ${response.status}`);

  // Rate limiting
  if (response.status === 429 && retryCount < 5) {
    const retryAfter = parseInt(response.headers.get("Retry-After") || "1", 10);
    log(`Rate limited. Retrying after ${retryAfter}s (attempt ${retryCount + 1})`);
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
    return fetchWithRetry(url, options, retryCount + 1);
  }

  // Auth error — try refresh once
  if (response.status === 401 && retryCount === 0) {
    log("Got 401, attempting token refresh...");
    const auth = readAuth();
    if (auth) {
      await refreshToken(auth);
      const newAuth = readAuth()!;
      const newHeaders = new Headers(options.headers);
      newHeaders.set("Authorization", `Bearer ${newAuth.access_token}`);
      return fetchWithRetry(url, { ...options, headers: newHeaders }, retryCount + 1);
    }
  }

  return response;
}

function parseDropboxError(body: unknown): { code: string; message: string } {
  if (typeof body === "object" && body !== null) {
    const obj = body as Record<string, unknown>;
    const errorTag = (obj.error as Record<string, unknown>)?.[".tag"] as string | undefined;
    const summary = obj.error_summary as string | undefined;
    return {
      code: errorTag || "api_error",
      message: summary || "API request failed",
    };
  }
  return { code: "api_error", message: "API request failed" };
}

export async function rpc<T = unknown>(endpoint: string, body: Record<string, unknown> = {}): Promise<T> {
  const auth = await getValidAuth();
  const response = await fetchWithRetry(`${RPC_BASE}/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    const { code, message } = parseDropboxError(errorBody);
    printError(code, message);
  }

  return response.json() as Promise<T>;
}

export async function contentUpload<T = unknown>(
  endpoint: string,
  metadata: Record<string, unknown>,
  content: Buffer | Uint8Array
): Promise<T> {
  const auth = await getValidAuth();
  const response = await fetchWithRetry(`${CONTENT_BASE}/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.access_token}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify(metadata),
    },
    body: content,
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    const { code, message } = parseDropboxError(errorBody);
    printError(code, message);
  }

  return response.json() as Promise<T>;
}

export async function contentDownload(
  endpoint: string,
  metadata: Record<string, unknown>
): Promise<{ metadata: Record<string, unknown>; body: ReadableStream<Uint8Array> }> {
  const auth = await getValidAuth();
  const response = await fetchWithRetry(`${CONTENT_BASE}/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.access_token}`,
      "Dropbox-API-Arg": JSON.stringify(metadata),
    },
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    const { code, message } = parseDropboxError(errorBody);
    printError(code, message);
  }

  const resultHeader = response.headers.get("Dropbox-API-Result");
  const resultMetadata = resultHeader ? JSON.parse(resultHeader) : {};

  return { metadata: resultMetadata, body: response.body! };
}

export async function pollBatchJob<T = unknown>(endpoint: string, asyncJobId: string): Promise<T> {
  while (true) {
    const result = await rpc<{ ".tag": string } & Record<string, unknown>>(endpoint, {
      async_job_id: asyncJobId,
    });

    if (result[".tag"] === "complete") {
      return result as T;
    }

    if (result[".tag"] === "in_progress") {
      log("Batch job in progress, polling again in 1s...");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    // Failed
    printError("batch_error", `Batch job failed: ${result[".tag"]}`);
  }
}
```

- [ ] **Step 2: Verify compilation**

```bash
bun build src/lib/api.ts --outdir /tmp/dbx-check --target bun
```

Expected: compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat: Dropbox API client with auth, retry, and rate limiting"
```

---

## Task 5: Auth Library & Commands

**Files:**
- Create: `src/lib/auth.ts`
- Create: `src/commands/auth.ts`

- [ ] **Step 1: Write src/lib/auth.ts**

```typescript
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { createHash, randomBytes } from "crypto";
import { createInterface } from "readline/promises";
import { readConfig, writeConfig, readAuth, writeAuth, clearAuth } from "./config";
import { log, logError } from "./logger";

const REDIRECT_PORT = 8910;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  Bun.spawn([cmd, url], { stdio: ["ignore", "ignore", "ignore"] });
}

async function promptForCredentials(): Promise<{ client_id: string; client_secret: string }> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });

  logError("\nNo app credentials found. You need a Dropbox app.");
  logError("Create one at: https://www.dropbox.com/developers/apps\n");
  logError("When creating the app:");
  logError("  - Choose 'Scoped access'");
  logError("  - Choose 'Full Dropbox' access type");
  logError(`  - Add redirect URI: ${REDIRECT_URI}\n`);

  const client_id = await rl.question("Client ID: ");
  const client_secret = await rl.question("Client secret: ");
  rl.close();

  return { client_id: client_id.trim(), client_secret: client_secret.trim() };
}

function waitForAuthCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url!, `http://localhost:${REDIRECT_PORT}`);

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(
            "<html><body><h1>Authorization failed</h1><p>You can close this window.</p></body></html>"
          );
          server.close();
          reject(new Error(`Authorization denied: ${error}`));
          return;
        }

        if (code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<html><body><h1>Authorization successful!</h1><p>You can close this window and return to the terminal.</p></body></html>"
          );
          server.close();
          resolve(code);
          return;
        }
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(REDIRECT_PORT, () => {
      log(`Auth callback server listening on port ${REDIRECT_PORT}`);
    });

    server.on("error", (err) => {
      reject(new Error(`Failed to start auth server on port ${REDIRECT_PORT}: ${err.message}`));
    });
  });
}

export async function login(): Promise<{
  account_email: string;
  account_id: string;
}> {
  // Step 1: Get or prompt for app credentials
  let config = readConfig();
  if (!config) {
    const creds = await promptForCredentials();
    config = creds;
    writeConfig(config);
    logError("App credentials saved.\n");
  }

  // Step 2: Generate PKCE
  const { verifier, challenge } = generatePKCE();

  // Step 3: Build authorization URL
  const authUrl = new URL("https://www.dropbox.com/oauth2/authorize");
  authUrl.searchParams.set("client_id", config.client_id);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("token_access_type", "offline");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);

  // Step 4: Start callback server and open browser
  const codePromise = waitForAuthCode();

  logError("Opening browser for Dropbox authorization...\n");
  openBrowser(authUrl.toString());

  // Step 5: Wait for auth code
  const code = await codePromise;
  log("Received authorization code");

  // Step 6: Exchange code for tokens
  logError("Exchanging authorization code for tokens...\n");
  const tokenResponse = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: config.client_id,
      client_secret: config.client_secret,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    throw new Error(`Token exchange failed: ${errorText}`);
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    account_id: string;
  };

  // Step 7: Get account info
  const accountResponse = await fetch(
    "https://api.dropboxapi.com/2/users/get_current_account",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json",
      },
      body: "null",
    }
  );

  const account = (await accountResponse.json()) as { email: string };

  // Step 8: Save auth data
  const authData = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + tokenData.expires_in,
    account_id: tokenData.account_id,
    account_email: account.email,
  };
  writeAuth(authData);

  return { account_email: account.email, account_id: tokenData.account_id };
}

export function logout(): void {
  clearAuth();
}

export function getStatus(): {
  logged_in: boolean;
  account_email?: string;
  account_id?: string;
  token_expires_at?: number;
  client_id?: string;
} {
  const auth = readAuth();
  const config = readConfig();

  if (!auth) {
    return { logged_in: false };
  }

  return {
    logged_in: true,
    account_email: auth.account_email,
    account_id: auth.account_id,
    token_expires_at: auth.expires_at,
    client_id: config?.client_id,
  };
}
```

- [ ] **Step 2: Write src/commands/auth.ts**

```typescript
import type { Command } from "commander";
import { login, logout, getStatus } from "../lib/auth";
import { printSuccess, printError, isHuman } from "../lib/output";
import { logError } from "../lib/logger";

export function registerAuthCommands(program: Command): void {
  const auth = program.command("auth").description("Manage Dropbox authentication");

  auth
    .command("login")
    .description("Authenticate with Dropbox via OAuth2")
    .action(async () => {
      try {
        const result = await login();
        if (isHuman()) {
          logError(`\nAuthenticated as ${result.account_email}\n`);
        }
        printSuccess({
          message: "Authentication successful",
          account_email: result.account_email,
          account_id: result.account_id,
        });
      } catch (err) {
        printError(
          "auth_failed",
          err instanceof Error ? err.message : "Authentication failed"
        );
      }
    });

  auth
    .command("logout")
    .description("Clear stored authentication tokens")
    .action(() => {
      logout();
      if (isHuman()) {
        logError("Logged out successfully.\n");
      }
      printSuccess({ message: "Logged out" });
    });

  auth
    .command("status")
    .description("Show current authentication status")
    .action(() => {
      const status = getStatus();
      if (isHuman()) {
        if (status.logged_in) {
          logError(`Logged in as: ${status.account_email}`);
          logError(
            `Token expires: ${new Date((status.token_expires_at || 0) * 1000).toLocaleString()}`
          );
          logError(`App client ID: ${status.client_id}\n`);
        } else {
          logError("Not logged in. Run `dropbox-cli auth login` to authenticate.\n");
        }
      }
      printSuccess(status);
    });
}
```

- [ ] **Step 3: Verify compilation**

```bash
bun build src/commands/auth.ts --outdir /tmp/dbx-check --target bun --external commander
```

Expected: compiles without errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/auth.ts src/commands/auth.ts
git commit -m "feat: OAuth2 auth flow with login, logout, status commands"
```

---

## Task 6: ls Command

**Files:**
- Create: `src/commands/ls.ts`

- [ ] **Step 1: Write src/commands/ls.ts**

```typescript
import type { Command } from "commander";
import { rpc } from "../lib/api";
import { printSuccess, isHuman, formatBytes, formatDate } from "../lib/output";
import { logError } from "../lib/logger";
import type { ListFolderResult, DropboxEntry } from "../types";

export function registerLsCommand(program: Command): void {
  program
    .command("ls [path]")
    .description("List files and folders in a Dropbox directory")
    .action(async (path: string = "") => {
      // Dropbox uses "" for root, not "/"
      const dbxPath = path === "/" ? "" : path;

      // First page
      let result = await rpc<ListFolderResult>("files/list_folder", {
        path: dbxPath,
        include_mounted_folders: true,
        include_non_downloadable_files: true,
      });

      const allEntries: DropboxEntry[] = [...result.entries];

      // Auto-paginate
      while (result.has_more) {
        result = await rpc<ListFolderResult>("files/list_folder/continue", {
          cursor: result.cursor,
        });
        allEntries.push(...result.entries);
      }

      if (isHuman()) {
        if (allEntries.length === 0) {
          logError("(empty folder)\n");
        } else {
          // Print header
          logError(
            `${"Type".padEnd(8)}${"Name".padEnd(40)}${"Size".padStart(12)}  Modified`
          );
          logError("-".repeat(80));
          for (const entry of allEntries) {
            const type = entry[".tag"] === "folder" ? "folder" : "file";
            const size =
              entry[".tag"] === "file" ? formatBytes(entry.size) : "-";
            const modified =
              entry[".tag"] === "file"
                ? formatDate(entry.server_modified)
                : "-";
            logError(
              `${type.padEnd(8)}${entry.name.padEnd(40)}${size.padStart(12)}  ${modified}`
            );
          }
          logError(`\n${allEntries.length} items`);
        }
      }

      printSuccess(allEntries);
    });
}
```

- [ ] **Step 2: Verify compilation**

```bash
bun build src/commands/ls.ts --outdir /tmp/dbx-check --target bun --external commander
```

Expected: compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add src/commands/ls.ts
git commit -m "feat: ls command with auto-pagination"
```

---

## Task 7: info & mkdir Commands

**Files:**
- Create: `src/commands/info.ts`
- Create: `src/commands/mkdir.ts`

- [ ] **Step 1: Write src/commands/info.ts**

```typescript
import type { Command } from "commander";
import { rpc } from "../lib/api";
import { printSuccess, isHuman, formatBytes, formatDate } from "../lib/output";
import { logError } from "../lib/logger";
import type { DropboxEntry } from "../types";

export function registerInfoCommand(program: Command): void {
  program
    .command("info <path>")
    .description("Get metadata for a file or folder")
    .action(async (path: string) => {
      const result = await rpc<DropboxEntry>("files/get_metadata", {
        path,
        include_media_info: true,
        include_has_explicit_shared_members: true,
      });

      if (isHuman()) {
        logError(`Path: ${result.path_display}`);
        logError(`Type: ${result[".tag"]}`);
        logError(`Name: ${result.name}`);
        if (result[".tag"] === "file") {
          logError(`Size: ${formatBytes(result.size)}`);
          logError(`Modified: ${formatDate(result.server_modified)}`);
          logError(`Rev: ${result.rev}`);
          logError(`Content hash: ${result.content_hash}`);
        }
      }

      printSuccess(result);
    });
}
```

- [ ] **Step 2: Write src/commands/mkdir.ts**

```typescript
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
```

- [ ] **Step 3: Verify compilation**

```bash
bun build src/commands/info.ts src/commands/mkdir.ts --outdir /tmp/dbx-check --target bun --external commander
```

Expected: compiles without errors.

- [ ] **Step 4: Commit**

```bash
git add src/commands/info.ts src/commands/mkdir.ts
git commit -m "feat: info and mkdir commands"
```

---

## Task 8: Upload Command

**Files:**
- Create: `src/commands/upload.ts`

- [ ] **Step 1: Write src/commands/upload.ts**

The upload command handles single files (<=150MB via `/files/upload`) and large files (>150MB via upload sessions). It also supports multiple local files uploaded to a remote directory.

```typescript
import type { Command } from "commander";
import { contentUpload, rpc } from "../lib/api";
import { printSuccess, printError, isHuman, formatBytes } from "../lib/output";
import { log, logError } from "../lib/logger";
import { statSync, readFileSync } from "fs";
import { basename, resolve } from "path";
import type { FileMetadata } from "../types";

const SINGLE_UPLOAD_LIMIT = 150 * 1024 * 1024; // 150MB
const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB chunks

type WriteMode = { ".tag": "add" } | { ".tag": "update"; update: string } | { ".tag": "overwrite" };

async function uploadSingleFile(
  localPath: string,
  remotePath: string,
  autorename: boolean
): Promise<FileMetadata> {
  const absolutePath = resolve(localPath);
  const stat = statSync(absolutePath);
  const content = readFileSync(absolutePath);

  if (isHuman()) {
    logError(`Uploading ${basename(localPath)} (${formatBytes(stat.size)})...`);
  }

  if (stat.size <= SINGLE_UPLOAD_LIMIT) {
    return contentUpload<FileMetadata>("files/upload", {
      path: remotePath,
      mode: { ".tag": "add" } as WriteMode,
      autorename,
      mute: false,
      strict_conflict: !autorename,
    }, content);
  }

  // Chunked upload for large files
  return chunkedUpload(content, remotePath, autorename);
}

async function chunkedUpload(
  content: Buffer,
  remotePath: string,
  autorename: boolean
): Promise<FileMetadata> {
  const totalSize = content.length;
  let offset = 0;

  // Start session
  const startResult = await contentUpload<{ session_id: string }>(
    "files/upload_session/start",
    { close: false },
    content.subarray(0, CHUNK_SIZE)
  );
  offset = CHUNK_SIZE;
  log(`Upload session started: ${startResult.session_id}`);

  // Append chunks
  while (offset + CHUNK_SIZE < totalSize) {
    const chunk = content.subarray(offset, offset + CHUNK_SIZE);
    await contentUpload("files/upload_session/append_v2", {
      cursor: { session_id: startResult.session_id, offset },
      close: false,
    }, chunk);
    offset += CHUNK_SIZE;

    if (isHuman()) {
      const pct = Math.round((offset / totalSize) * 100);
      logError(`  Progress: ${pct}% (${formatBytes(offset)} / ${formatBytes(totalSize)})`);
    }
  }

  // Finish with last chunk
  const lastChunk = content.subarray(offset);
  return contentUpload<FileMetadata>("files/upload_session/finish", {
    cursor: { session_id: startResult.session_id, offset },
    commit: {
      path: remotePath,
      mode: { ".tag": "add" } as WriteMode,
      autorename,
      mute: false,
      strict_conflict: !autorename,
    },
  }, lastChunk);
}

export function registerUploadCommand(program: Command): void {
  program
    .command("upload <sources...>")
    .description(
      "Upload file(s) to Dropbox. Last argument is the remote path. " +
      "For multiple files, the remote path must be a directory."
    )
    .option("--autorename", "Automatically rename on conflict")
    .action(async (sources: string[], options: { autorename?: boolean }) => {
      if (sources.length < 2) {
        printError("invalid_args", "Usage: dropbox-cli upload <local-file...> <remote-path>");
      }

      const remoteDest = sources[sources.length - 1];
      const localFiles = sources.slice(0, -1);
      const autorename = options.autorename ?? false;

      const results: FileMetadata[] = [];

      for (const localFile of localFiles) {
        // If uploading multiple files, treat remoteDest as a directory
        const remotePath =
          localFiles.length > 1
            ? `${remoteDest}/${basename(localFile)}`
            : remoteDest;

        const result = await uploadSingleFile(localFile, remotePath, autorename);
        results.push(result);

        if (isHuman()) {
          logError(`  Uploaded to: ${result.path_display}`);
        }
      }

      printSuccess(localFiles.length === 1 ? results[0] : results);
    });
}
```

- [ ] **Step 2: Verify compilation**

```bash
bun build src/commands/upload.ts --outdir /tmp/dbx-check --target bun --external commander
```

Expected: compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add src/commands/upload.ts
git commit -m "feat: upload command with chunked upload for large files"
```

---

## Task 9: Download Command

**Files:**
- Create: `src/commands/download.ts`

- [ ] **Step 1: Write src/commands/download.ts**

```typescript
import type { Command } from "commander";
import { contentDownload } from "../lib/api";
import { printSuccess, printError, isHuman, formatBytes } from "../lib/output";
import { logError } from "../lib/logger";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { basename, join, dirname, resolve } from "path";

async function downloadSingleFile(
  remotePath: string,
  localDir: string
): Promise<{ remote_path: string; local_path: string; size: number }> {
  const { metadata, body } = await contentDownload("files/download", {
    path: remotePath,
  });

  const fileName = (metadata as { name?: string }).name || basename(remotePath);
  const localPath = resolve(join(localDir, fileName));

  // Ensure local directory exists
  const dir = dirname(localPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (isHuman()) {
    logError(`Downloading ${fileName}...`);
  }

  // Stream to file
  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const fullContent = Buffer.concat(chunks);
  writeFileSync(localPath, fullContent);

  if (isHuman()) {
    logError(`  Saved to: ${localPath} (${formatBytes(fullContent.length)})`);
  }

  return {
    remote_path: remotePath,
    local_path: localPath,
    size: fullContent.length,
  };
}

export function registerDownloadCommand(program: Command): void {
  program
    .command("download <sources...>")
    .description(
      "Download file(s) from Dropbox. Last argument is the local directory (defaults to current directory)."
    )
    .action(async (sources: string[]) => {
      // If only one arg, download to current dir
      // If multiple args, last one is local destination
      let remotePaths: string[];
      let localDir: string;

      if (sources.length === 1) {
        remotePaths = [sources[0]];
        localDir = ".";
      } else {
        // Check if last arg looks like a remote path (starts with /)
        const last = sources[sources.length - 1];
        if (last.startsWith("/")) {
          // All args are remote paths, download to current dir
          remotePaths = sources;
          localDir = ".";
        } else {
          remotePaths = sources.slice(0, -1);
          localDir = last;
        }
      }

      const results: Array<{ remote_path: string; local_path: string; size: number }> = [];

      for (const remotePath of remotePaths) {
        const result = await downloadSingleFile(remotePath, localDir);
        results.push(result);
      }

      printSuccess(results.length === 1 ? results[0] : results);
    });
}
```

- [ ] **Step 2: Verify compilation**

```bash
bun build src/commands/download.ts --outdir /tmp/dbx-check --target bun --external commander
```

Expected: compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add src/commands/download.ts
git commit -m "feat: download command with streaming file writes"
```

---

## Task 10: mv & cp Commands

**Files:**
- Create: `src/commands/mv.ts`
- Create: `src/commands/cp.ts`

- [ ] **Step 1: Write src/commands/mv.ts**

```typescript
import type { Command } from "commander";
import { rpc, pollBatchJob } from "../lib/api";
import { printSuccess, printError, isHuman } from "../lib/output";
import { logError } from "../lib/logger";
import type { DropboxEntry, BatchResult } from "../types";
import { basename } from "path";

export function registerMvCommand(program: Command): void {
  program
    .command("mv <sources...>")
    .description(
      "Move/rename file(s) in Dropbox. Last argument is the destination. " +
      "For multiple files, destination must be a directory."
    )
    .option("--autorename", "Automatically rename on conflict")
    .action(async (sources: string[], options: { autorename?: boolean }) => {
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

        if (isHuman()) {
          logError(`Moved to: ${result.metadata.path_display}`);
        }

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
          if (isHuman()) logError("Batch move in progress...");
          const completed = await pollBatchJob<BatchResult>(
            "files/move_batch/check_v2",
            result.async_job_id!
          );
          if (isHuman()) logError("Batch move complete.");
          printSuccess(completed.entries);
        } else {
          if (isHuman()) logError("Batch move complete.");
          printSuccess(result.entries);
        }
      }
    });
}
```

- [ ] **Step 2: Write src/commands/cp.ts**

```typescript
import type { Command } from "commander";
import { rpc, pollBatchJob } from "../lib/api";
import { printSuccess, printError, isHuman } from "../lib/output";
import { logError } from "../lib/logger";
import type { DropboxEntry, BatchResult } from "../types";
import { basename } from "path";

export function registerCpCommand(program: Command): void {
  program
    .command("cp <sources...>")
    .description(
      "Copy file(s) in Dropbox. Last argument is the destination. " +
      "For multiple files, destination must be a directory."
    )
    .option("--autorename", "Automatically rename on conflict")
    .action(async (sources: string[], options: { autorename?: boolean }) => {
      if (sources.length < 2) {
        printError("invalid_args", "Usage: dropbox-cli cp <source...> <destination>");
      }

      const dest = sources[sources.length - 1];
      const srcPaths = sources.slice(0, -1);
      const autorename = options.autorename ?? false;

      if (srcPaths.length === 1) {
        // Single file copy
        const result = await rpc<{ metadata: DropboxEntry }>("files/copy_v2", {
          from_path: srcPaths[0],
          to_path: dest,
          autorename,
        });

        if (isHuman()) {
          logError(`Copied to: ${result.metadata.path_display}`);
        }

        printSuccess(result.metadata);
      } else {
        // Batch copy
        const entries = srcPaths.map((src) => ({
          from_path: src,
          to_path: `${dest}/${basename(src)}`,
        }));

        const result = await rpc<BatchResult>("files/copy_batch_v2", {
          entries,
          autorename,
        });

        if (result[".tag"] === "async_job_id") {
          if (isHuman()) logError("Batch copy in progress...");
          const completed = await pollBatchJob<BatchResult>(
            "files/copy_batch/check_v2",
            result.async_job_id!
          );
          if (isHuman()) logError("Batch copy complete.");
          printSuccess(completed.entries);
        } else {
          if (isHuman()) logError("Batch copy complete.");
          printSuccess(result.entries);
        }
      }
    });
}
```

- [ ] **Step 3: Verify compilation**

```bash
bun build src/commands/mv.ts src/commands/cp.ts --outdir /tmp/dbx-check --target bun --external commander
```

Expected: compiles without errors.

- [ ] **Step 4: Commit**

```bash
git add src/commands/mv.ts src/commands/cp.ts
git commit -m "feat: mv and cp commands with batch support"
```

---

## Task 11: Search & Share Commands

**Files:**
- Create: `src/commands/search.ts`
- Create: `src/commands/share.ts`
- Modify: `src/lib/api.ts` (add `rpcRaw` export)

- [ ] **Step 1: Write src/commands/search.ts**

```typescript
import type { Command } from "commander";
import { rpc } from "../lib/api";
import { printSuccess, isHuman, formatBytes } from "../lib/output";
import { logError } from "../lib/logger";
import type { SearchResult, DropboxEntry } from "../types";

export function registerSearchCommand(program: Command): void {
  program
    .command("search <query>")
    .description("Search for files and folders by name")
    .option("--path <path>", "Limit search to a specific folder path")
    .option("--max <count>", "Maximum number of results", "100")
    .action(async (query: string, options: { path?: string; max?: string }) => {
      const searchOptions: Record<string, unknown> = {
        query,
        options: {
          max_results: parseInt(options.max || "100", 10),
          file_status: { ".tag": "active" },
          filename_only: false,
        },
      };

      if (options.path) {
        (searchOptions.options as Record<string, unknown>).path = options.path;
      }

      const result = await rpc<SearchResult>("files/search_v2", searchOptions);

      const entries: DropboxEntry[] = result.matches.map(
        (m) => m.metadata.metadata
      );

      if (isHuman()) {
        if (entries.length === 0) {
          logError("No results found.\n");
        } else {
          logError(`Found ${entries.length} result(s):\n`);
          for (const entry of entries) {
            const type = entry[".tag"] === "folder" ? "folder" : "file";
            const size =
              entry[".tag"] === "file" ? ` (${formatBytes(entry.size)})` : "";
            logError(`  [${type}] ${entry.path_display}${size}`);
          }
        }
      }

      printSuccess(entries);
    });
}
```

- [ ] **Step 2: Add `rpcRaw` to src/lib/api.ts**

The share command needs to handle the `shared_link_already_exists` error gracefully (fall back to listing existing links). Since `rpc()` calls `process.exit` on errors, add a `rpcRaw` method that returns the response without exiting:

```typescript
// Add this export to src/lib/api.ts

export async function rpcRaw(endpoint: string, body: Record<string, unknown> = {}): Promise<{
  ok: boolean;
  status: number;
  data: unknown;
}> {
  const auth = await getValidAuth();
  const response = await fetchWithRetry(`${RPC_BASE}/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, data };
}
```

- [ ] **Step 3: Write src/commands/share.ts**

```typescript
import type { Command } from "commander";
import { rpc, rpcRaw } from "../lib/api";
import { printSuccess, printError, isHuman } from "../lib/output";
import { logError } from "../lib/logger";
import type { SharedLinkMetadata } from "../types";

export function registerShareCommand(program: Command): void {
  program
    .command("share <path>")
    .description("Create a shared link for a file or folder")
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
```

- [ ] **Step 4: Verify compilation**

```bash
bun build src/commands/search.ts src/commands/share.ts --outdir /tmp/dbx-check --target bun --external commander
```

Expected: compiles without errors.

- [ ] **Step 5: Commit**

```bash
git add src/commands/search.ts src/commands/share.ts src/lib/api.ts
git commit -m "feat: search and share commands"
```

---

## Task 12: Entry Point & Build

**Files:**
- Create: `src/index.ts`
- Modify: `package.json` (add scripts, bin)

- [ ] **Step 1: Write src/index.ts**

```typescript
#!/usr/bin/env bun
import { Command } from "commander";
import { setVerbose } from "./lib/logger";
import { setHumanMode } from "./lib/output";
import { registerAuthCommands } from "./commands/auth";
import { registerLsCommand } from "./commands/ls";
import { registerInfoCommand } from "./commands/info";
import { registerMkdirCommand } from "./commands/mkdir";
import { registerUploadCommand } from "./commands/upload";
import { registerDownloadCommand } from "./commands/download";
import { registerMvCommand } from "./commands/mv";
import { registerCpCommand } from "./commands/cp";
import { registerSearchCommand } from "./commands/search";
import { registerShareCommand } from "./commands/share";

const program = new Command();

program
  .name("dropbox-cli")
  .description("CLI for the Dropbox API. Outputs JSON by default.")
  .version("1.0.0")
  .option("--human", "Human-readable output instead of JSON")
  .option("--verbose", "Debug logging to stderr");

// Apply global options before any command runs
program.hook("preAction", (thisCommand) => {
  const opts = thisCommand.optsWithGlobals();
  setVerbose(opts.verbose ?? false);
  setHumanMode(opts.human ?? false);
});

// Register all commands
registerAuthCommands(program);
registerLsCommand(program);
registerInfoCommand(program);
registerMkdirCommand(program);
registerUploadCommand(program);
registerDownloadCommand(program);
registerMvCommand(program);
registerCpCommand(program);
registerSearchCommand(program);
registerShareCommand(program);

program.parse();
```

- [ ] **Step 2: Update package.json**

Add these fields to `package.json`:

```json
{
  "name": "dropbox-cli",
  "version": "1.0.0",
  "type": "module",
  "bin": {
    "dropbox-cli": "./dist/dropbox-cli"
  },
  "scripts": {
    "dev": "bun run src/index.ts",
    "build": "bun build src/index.ts --compile --outfile dist/dropbox-cli",
    "build:cross": "bun build src/index.ts --compile --outfile dist/dropbox-cli --target=bun-linux-x64 && bun build src/index.ts --compile --outfile dist/dropbox-cli-darwin --target=bun-darwin-arm64",
    "test": "bun test"
  }
}
```

- [ ] **Step 3: Test dev mode**

```bash
bun run dev -- --help
```

Expected: shows help text with all commands listed.

```bash
bun run dev -- auth --help
```

Expected: shows auth subcommands (login, logout, status).

- [ ] **Step 4: Build the binary**

```bash
bun run build
```

Expected: produces `dist/dropbox-cli` standalone binary.

- [ ] **Step 5: Test the binary**

```bash
./dist/dropbox-cli --help
./dist/dropbox-cli --version
```

Expected: help output shows all commands; version shows 1.0.0.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts package.json
echo "dist/" >> .gitignore
echo "node_modules/" >> .gitignore
git add .gitignore
git commit -m "feat: entry point, build config, and standalone binary compilation"
```

---

## Task 13: End-to-End Verification

This task uses a real Dropbox account to verify all commands work correctly.

**Prerequisites:** A Dropbox app with `client_id` and `client_secret` (create at https://www.dropbox.com/developers/apps).

- [ ] **Step 1: Auth flow**

```bash
./dist/dropbox-cli auth login
```

Expected: opens browser, user authorizes, tokens saved. Output:
```json
{ "ok": true, "data": { "message": "Authentication successful", "account_email": "...", "account_id": "..." } }
```

- [ ] **Step 2: Auth status**

```bash
./dist/dropbox-cli auth status
```

Expected: shows logged-in state with email and expiry.

- [ ] **Step 3: List root**

```bash
./dist/dropbox-cli ls /
```

Expected: JSON array of entries in root folder.

- [ ] **Step 4: Create folder**

```bash
./dist/dropbox-cli mkdir /dropbox-cli-test
```

Expected: returns created folder metadata.

- [ ] **Step 5: Upload a file**

```bash
echo "hello from dropbox-cli" > /tmp/test-upload.txt
./dist/dropbox-cli upload /tmp/test-upload.txt /dropbox-cli-test/test-upload.txt
```

Expected: returns uploaded file metadata with path `/dropbox-cli-test/test-upload.txt`.

- [ ] **Step 6: List folder**

```bash
./dist/dropbox-cli ls /dropbox-cli-test
```

Expected: shows `test-upload.txt` in the listing.

- [ ] **Step 7: Get file info**

```bash
./dist/dropbox-cli info /dropbox-cli-test/test-upload.txt
```

Expected: returns file metadata with size, modified date, content hash.

- [ ] **Step 8: Download file**

```bash
./dist/dropbox-cli download /dropbox-cli-test/test-upload.txt /tmp/
cat /tmp/test-upload.txt
```

Expected: file downloaded, contents match "hello from dropbox-cli".

- [ ] **Step 9: Copy file**

```bash
./dist/dropbox-cli cp /dropbox-cli-test/test-upload.txt /dropbox-cli-test/test-copy.txt
```

Expected: returns copied file metadata.

- [ ] **Step 10: Move file**

```bash
./dist/dropbox-cli mv /dropbox-cli-test/test-copy.txt /dropbox-cli-test/test-moved.txt
```

Expected: returns moved file metadata.

- [ ] **Step 11: Search**

```bash
./dist/dropbox-cli search "test-upload"
```

Expected: returns search results including `/dropbox-cli-test/test-upload.txt`.

- [ ] **Step 12: Share**

```bash
./dist/dropbox-cli share /dropbox-cli-test/test-upload.txt
```

Expected: returns shared link URL.

- [ ] **Step 13: Test --human flag**

```bash
./dist/dropbox-cli --human ls /dropbox-cli-test
```

Expected: formatted table output to stderr, JSON still on stdout.

- [ ] **Step 14: Test --verbose flag**

```bash
./dist/dropbox-cli --verbose ls /dropbox-cli-test
```

Expected: HTTP request/response details logged to stderr.

- [ ] **Step 15: Test JSON piping**

```bash
./dist/dropbox-cli ls /dropbox-cli-test | jq '.data[].name'
```

Expected: valid JSON, jq extracts file names.

- [ ] **Step 16: Test error handling**

```bash
./dist/dropbox-cli ls /nonexistent-path-12345
```

Expected: error JSON with code and message, exit code 1.

- [ ] **Step 17: Final commit**

```bash
git add -A
git commit -m "chore: end-to-end verification complete"
```
