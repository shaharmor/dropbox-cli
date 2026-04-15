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
  content: Uint8Array
): Promise<T> {
  const auth = await getValidAuth();
  const response = await fetchWithRetry(`${CONTENT_BASE}/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.access_token}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify(metadata),
    },
    body: content as BodyInit,
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
