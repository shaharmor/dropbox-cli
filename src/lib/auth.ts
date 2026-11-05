import { createServer } from "http";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { createInterface } from "readline/promises";
import {
  beginAuthAttempt, cancelAuthAttempt, clearAuth, readConfig, text, withCredentialStore, writeAuth, writeConfig,
} from "./config";
import { authDeadline } from "./auth-coordination";
import { CredentialError, type AppConfig } from "../types";
import { logError } from "./logger";

const REDIRECT_PORT = 8910;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const DEFAULT_LOGIN_TIMEOUT_MS = 180000;

export interface LoginOptions {
  interactive?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  callbackPort?: number;
  /** Make Dropbox ask the user to sign in again so they can choose another account. */
  forceReauthentication?: boolean;
  openBrowser?: (url: string) => void | Promise<void>;
}

async function openBrowser(url: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const child = Bun.spawn([cmd, url], { stdio: ["ignore", "ignore", "ignore"] });
  const cancel = () => {
    if (child.exitCode === null) child.kill();
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (await child.exited !== 0) throw new CredentialError("auth_browser_failed", "Cannot open the authorization browser.");
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

async function promptForCredentials(signal: AbortSignal): Promise<AppConfig> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    logError("No app credentials found. Create a Dropbox app at https://www.dropbox.com/developers/apps");
    logError(`Choose scoped, full Dropbox access and add redirect URI: ${REDIRECT_URI}`);
    const client_id = await rl.question("App key: ", { signal });
    const client_secret = await rl.question("App secret: ", { signal });
    return { client_id: client_id.trim(), client_secret: client_secret.trim() };
  } finally {
    rl.close();
  }
}

function isExpectedState(supplied: string[], state: string): boolean {
  return supplied.length === 1 && Buffer.byteLength(supplied[0]!) === Buffer.byteLength(state) &&
    timingSafeEqual(Buffer.from(supplied[0]!), Buffer.from(state));
}

function callbackError(params: URLSearchParams, state: string): CredentialError | undefined {
  if (!isExpectedState(params.getAll("state"), state)) {
    return new CredentialError("auth_state_mismatch", "Authorization state did not match.");
  }
  if (params.has("error")) return new CredentialError("auth_denied", "Dropbox authorization was denied.");
  if (params.getAll("code").length !== 1 || !params.get("code")) {
    return new CredentialError("auth_callback_invalid", "Authorization callback did not contain a valid code.");
  }
}

/** One-shot loopback server that resolves `code` with the first valid OAuth callback. */
function callbackServer(state: string, port: number) {
  const { promise: code, resolve: resolveCode, reject: rejectCode } = Promise.withResolvers<string>();
  // A callback may finish while the browser launcher is still returning.
  void code.catch(() => {});
  let settled = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== "/callback" || settled) {
      res.writeHead(404).end();
      return;
    }
    settled = true;
    const error = callbackError(url.searchParams, state);
    res.writeHead(error ? 400 : 200, { "Content-Type": "text/plain", "Cache-Control": "no-store", Connection: "close" });
    res.end(error ? "Authorization failed. You may close this window." : "Authorization received. You may close this window.");
    if (error) rejectCode(error);
    else resolveCode(url.searchParams.get("code")!);
  });
  const unavailable = () => new CredentialError("auth_callback_unavailable", "Cannot bind the loopback authorization callback.");
  const ready = new Promise<number>((resolve, reject) => {
    server.once("error", () => reject(unavailable()));
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(unavailable());
      else resolve(address.port);
    });
  });
  return {
    code,
    ready,
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

type Deadline = ReturnType<typeof authDeadline>;
type TokenResponse = { access_token: string; refresh_token: string; account_id: string; expires_in: number };

async function readAppCredentials(options: LoginOptions, deadline: Deadline): Promise<AppConfig> {
  if (!(options.interactive ?? (process.stdin.isTTY && process.stderr.isTTY))) {
    throw new CredentialError("app_credentials_required", "App credentials are missing. Configure them with an interactive CLI login first.");
  }
  const config = await deadline.wait(promptForCredentials(deadline.signal));
  deadline.signal.throwIfAborted();
  return config;
}

function authorizationUrl(config: AppConfig, challenge: string, redirect: string, state: string, forceReauthentication = false): string {
  const url = new URL("https://www.dropbox.com/oauth2/authorize");
  const params = new URLSearchParams({
    client_id: config.client_id,
    response_type: "code",
    token_access_type: "offline",
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: redirect,
    state,
  });
  if (forceReauthentication) params.set("force_reauthentication", "true");
  url.search = params.toString();
  return url.toString();
}

async function launchBrowser(url: string, options: LoginOptions, deadline: Deadline): Promise<void> {
  try {
    await deadline.wait(Promise.resolve().then(() =>
      options.openBrowser ? options.openBrowser(url) : openBrowser(url, deadline.signal)));
  } catch (error) {
    if (deadline.signal.aborted) throw deadline.signal.reason;
    if (error instanceof CredentialError) throw error;
    throw new CredentialError("auth_browser_failed", "Cannot open the authorization browser.");
  }
}

async function exchangeCode(
  config: AppConfig,
  code: string,
  redirect: string,
  verifier: string,
  deadline: Deadline,
): Promise<TokenResponse> {
  const response = await deadline.wait(fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    signal: deadline.signal,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: config.client_id,
      client_secret: config.client_secret,
      redirect_uri: redirect,
      code_verifier: verifier,
    }),
  }));
  if (!response.ok) throw new CredentialError("auth_exchange_failed", "Authorization token exchange failed.");
  const token = await deadline.wait(response.json()) as Record<string, unknown>;
  const valid = !!token &&
    [token.access_token, token.refresh_token, token.account_id].every(text) &&
    typeof token.expires_in === "number" && Number.isFinite(token.expires_in) && token.expires_in > 0;
  if (!valid) throw new CredentialError("auth_exchange_failed", "Invalid authorization token response.");
  return token as TokenResponse;
}

/** The email of the account the token belongs to, after checking it matches the token's account ID. */
async function verifyAccount(token: TokenResponse, deadline: Deadline): Promise<string> {
  const response = await deadline.wait(fetch("https://api.dropboxapi.com/2/users/get_current_account", {
    method: "POST",
    signal: deadline.signal,
    headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" },
    body: "null",
  }));
  if (!response.ok) throw new CredentialError("auth_account_failed", "Cannot verify the connected account.");
  const account = await deadline.wait(response.json()) as Record<string, unknown>;
  if (!account || account.account_id !== token.account_id || typeof account.email !== "string" || !account.email) {
    throw new CredentialError("auth_account_failed", "Connected account identity could not be verified.");
  }
  return account.email;
}

/**
 * OAuth2 PKCE login through a loopback callback. The attempt is fenced by a credential
 * generation, so a concurrent login, logout or app-credential change supersedes it.
 */
export async function login(options: LoginOptions = {}): Promise<{ account_email: string; account_id: string }> {
  const deadline = authDeadline(options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS, options.signal);
  let generation: string | undefined;
  let callback: ReturnType<typeof callbackServer> | undefined;
  let completed = false;
  try {
    deadline.signal.throwIfAborted();
    generation = beginAuthAttempt();
    let config = readConfig();
    if (!config) {
      config = await readAppCredentials(options, deadline);
      generation = writeConfig(config, generation);
    }

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(32).toString("base64url");
    callback = callbackServer(state, options.callbackPort ?? REDIRECT_PORT);
    const redirect = `http://localhost:${await deadline.wait(callback.ready)}/callback`;
    logError("Opening browser for Dropbox authorization...");
    await launchBrowser(authorizationUrl(config, challenge, redirect, state, options.forceReauthentication), options, deadline);
    const code = await deadline.wait(callback.code);
    await callback.close();
    callback = undefined;

    const token = await exchangeCode(config, code, redirect, verifier, deadline);
    const email = await verifyAccount(token, deadline);
    deadline.signal.throwIfAborted();
    writeAuth({
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + token.expires_in,
      account_id: token.account_id,
      account_email: email,
    }, generation);
    completed = true;
    return { account_email: email, account_id: token.account_id };
  } catch (error) {
    if (deadline.signal.aborted) throw deadline.signal.reason;
    if (error instanceof CredentialError) throw error;
    throw new CredentialError("connection_error", "Authentication could not complete. Check the connection and retry.");
  } finally {
    deadline.close();
    await callback?.close();
    if (!completed && generation !== undefined) cancelAuthAttempt(generation);
  }
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
  return withCredentialStore(store => {
    const auth = store.snapshot();
    const config = store.readConfig();
    if (!auth) return { logged_in: false };
    return {
      logged_in: true,
      account_email: auth.account_email,
      account_id: auth.account_id,
      token_expires_at: auth.expires_at,
      client_id: config?.client_id,
    };
  });
}
