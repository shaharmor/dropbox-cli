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

  const client_id = await rl.question("App key: ");
  const client_secret = await rl.question("App secret: ");
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
