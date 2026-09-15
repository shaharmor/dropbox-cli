import { withCredentialStoreAsync } from "./config";
import { authDeadline } from "./auth-coordination";
import { log } from "./logger";
import { printError } from "./output";
import { CredentialError, type AuthRequestOptions, type CredentialSnapshot, type RequestOptions } from "../types";

const RPC_BASE = "https://api.dropboxapi.com/2";
const CONTENT_BASE = "https://content.dropboxapi.com/2";
const responseSecrets = new WeakMap<Response, readonly string[]>();

function redactError(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    for (const secret of secrets) value = (value as string).split(secret).join("[REDACTED]");
    return value;
  }
  if (Array.isArray(value)) return value.map(item => redactError(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactError(item, secrets)]));
  }
  return value;
}

async function readError(response: Response): Promise<unknown> {
  const body = await response.json().catch(() => null);
  return redactError(body, responseSecrets.get(response) ?? []);
}

async function failResponse(response: Response): Promise<never> {
  if (response.status === 401) printError("auth_error", "Dropbox authentication was refused. Reconnect the account.", 2);
  const { code, message } = parseDropboxError(await readError(response));
  printError(code, message);
}

export async function getCredentialSnapshot(
  options: AuthRequestOptions = {}, rejected?: CredentialSnapshot
): Promise<CredentialSnapshot> {
  return withCredentialStoreAsync(async store => {
    const auth = store.snapshot();
    if (!auth) throw new CredentialError("auth_error", "Not authenticated. Run `dropbox-cli auth login` first.");
    const expected = options.expectedAccountId ?? rejected?.account_id;
    if (expected !== undefined && auth.account_id !== expected) {
      throw new CredentialError("account_mismatch", "Configured account does not match the requested account.");
    }
    if (options.signal?.aborted) throw new CredentialError("auth_cancelled", "Authentication cancelled.");
    const expired = Date.now() / 1000 >= auth.expires_at - 300;
    if (!expired && (!rejected || rejected.generation !== auth.generation)) return auth;
    const config = store.readConfig();
    if (!config) throw new CredentialError("auth_error", "No app credentials found. Run `dropbox-cli auth login` first.");
    const deadline = authDeadline(options.refreshTimeoutMs ?? 15000, options.signal);
    try {
      log("Refreshing access token...");
      const response = await deadline.wait(fetch("https://api.dropboxapi.com/oauth2/token", {
        method: "POST", signal: deadline.signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: auth.refresh_token,
          client_id: config.client_id, client_secret: config.client_secret }),
      }));
      if (!response.ok) throw new CredentialError("auth_error", "Token refresh failed. Reconnect the account.");
      const data = await deadline.wait(response.json()) as { access_token?: unknown; expires_in?: unknown; account_id?: unknown };
      if (!data || typeof data.access_token !== "string" || !data.access_token ||
          typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0 ||
          (data.account_id !== undefined && data.account_id !== auth.account_id)) {
        throw new CredentialError("auth_error", "Invalid token refresh response. Reconnect the account.");
      }
      deadline.signal.throwIfAborted();
      store.writeAuth({ ...auth, access_token: data.access_token,
        expires_at: Math.floor(Date.now() / 1000) + data.expires_in }, auth.generation);
      return store.snapshot()!;
    } catch (error) {
      if (error instanceof CredentialError) throw error;
      if (deadline.signal.aborted) throw deadline.signal.reason;
      throw new CredentialError("connection_error", "Cannot refresh credentials. Check the connection and retry.");
    } finally { deadline.close(); }
  });
}

const READ_ENDPOINTS = new Set([
  "files/list_folder", "files/list_folder/continue", "files/get_metadata",
  "files/search_v2", "files/search/continue_v2", "users/get_current_account",
  "files/download", "sharing/list_shared_links",
  "files/copy_batch/check_v2", "files/move_batch/check_v2", "files/upload_session/finish_batch/check",
]);

async function fetchWithRetry(url: string, init: RequestInit, options: RequestOptions = {}): Promise<Response> {
  try {
    let auth = await getCredentialSnapshot(options);
    const secrets = [auth.access_token, auth.refresh_token];
    // Pin the original account even if the caller did not supply an expected account.
    const bound = { ...options, expectedAccountId: auth.account_id };
    const endpoint = url.replace(`${RPC_BASE}/`, "").replace(`${CONTENT_BASE}/`, "");
    const read = (options.retry ?? (READ_ENDPOINTS.has(endpoint) ? "read" : "mutation")) === "read";
    let retries = 0, recovered = false;
    while (true) {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${auth.access_token}`);
      log(`POST ${url}`);
      const response = await fetch(url, { ...init, headers, signal: options.signal });
      log(`Response: ${response.status}`);
      responseSecrets.set(response, secrets);
      // Mutations never redispatch automatically, including after 401. A refreshed
      // credential is not evidence that an earlier mutation was not applied.
      if (!read) return response;
      if (response.status === 401 && !recovered) {
        recovered = true;
        await response.body?.cancel();
        auth = await getCredentialSnapshot(bound, auth);
        secrets.push(auth.access_token, auth.refresh_token);
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && retries < 5) {
        const requested = Number(response.headers.get("Retry-After") ?? "1");
        const delay = response.status === 429 ? (Number.isFinite(requested) ? Math.max(0, Math.min(requested, 30)) : 1) : Math.min(2 ** retries, 16);
        retries++;
        await response.body?.cancel();
        await Bun.sleep(delay * 1000);
        continue;
      }
      return response;
    }
  } catch (error) {
    if (error instanceof CredentialError) printError(error.code, error.message, 2);
    printError("connection_error", "Dropbox request could not be completed.");
  }
}

function parseDropboxError(body: unknown): { code: string; message: string } {
  if (typeof body === "object" && body !== null) {
    const obj = body as Record<string, unknown>;
    const errorTag = (obj.error as Record<string, unknown>)?.[".tag"] as string | undefined;
    const summary = obj.error_summary as string | undefined;
    return {
      code: typeof errorTag === "string" && errorTag ? errorTag : "api_error",
      message: typeof summary === "string" && summary ? summary : "API request failed",
    };
  }
  return { code: "api_error", message: "API request failed" };
}

export async function rpc<T = unknown>(endpoint: string, body: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<T> {
  const response = await fetchWithRetry(`${RPC_BASE}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, options);

  if (!response.ok) await failResponse(response);

  return response.json() as Promise<T>;
}

export async function contentUpload<T = unknown>(
  endpoint: string,
  metadata: Record<string, unknown>,
  content: Uint8Array,
  options: RequestOptions = {}
): Promise<T> {
  const response = await fetchWithRetry(`${CONTENT_BASE}/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify(metadata),
    },
    body: content as BodyInit,
  }, { ...options, retry: "mutation" });

  if (!response.ok) await failResponse(response);

  return response.json() as Promise<T>;
}

export async function contentDownload(
  endpoint: string,
  metadata: Record<string, unknown>,
  options: RequestOptions = {}
): Promise<{ metadata: Record<string, unknown>; body: ReadableStream<Uint8Array> }> {
  const response = await fetchWithRetry(`${CONTENT_BASE}/${endpoint}`, {
    method: "POST",
    headers: { "Dropbox-API-Arg": JSON.stringify(metadata) },
  }, options);

  if (!response.ok) await failResponse(response);

  const resultHeader = response.headers.get("Dropbox-API-Result");
  const resultMetadata = resultHeader ? JSON.parse(resultHeader) : {};

  return { metadata: resultMetadata, body: response.body! };
}

export async function pollBatchJob<T = unknown>(endpoint: string, asyncJobId: string, label?: string): Promise<T> {
  const prefix = label ? `[${label}] ` : "";
  let delay = 1;
  while (true) {
    const result = await rpc<{ ".tag": string } & Record<string, unknown>>(endpoint, {
      async_job_id: asyncJobId,
    });

    if (result[".tag"] === "complete") {
      return result as T;
    }

    if (result[".tag"] === "in_progress") {
      log(`${prefix}Batch job in progress, polling again in ${delay}s...`);
      await new Promise((resolve) => setTimeout(resolve, delay * 1000));
      delay = Math.min(delay * 2, 10);
      continue;
    }

    // Failed
    printError("batch_error", `${prefix}Batch job failed: ${result[".tag"]}`);
  }
}

export async function rpcRaw(endpoint: string, body: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<{
  ok: boolean;
  status: number;
  data: unknown;
}> {
  const response = await fetchWithRetry(`${RPC_BASE}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, options);

  const data = response.ok ? await response.json().catch(() => null) : await readError(response);
  return { ok: response.ok, status: response.status, data };
}
