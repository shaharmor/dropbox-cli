import { withCredentialStoreAsync } from "./config";
import { authDeadline, MAX_REFRESH_MS } from "./auth-coordination";
import { log } from "./logger";
import { printError } from "./output";
import { CredentialError, MachineError, type AuthRequestOptions, type CredentialSnapshot, type RequestOptions, type MachineMetadata } from "../types";

const RPC_BASE = "https://api.dropboxapi.com/2";
const CONTENT_BASE = "https://content.dropboxapi.com/2";
const responseSecrets = new WeakMap<Response, readonly string[]>();
const responseReceivedAt = new WeakMap<Response, number>();

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
    const refreshTimeoutMs = options.refreshTimeoutMs ?? MAX_REFRESH_MS;
    if (refreshTimeoutMs > MAX_REFRESH_MS) throw new CredentialError("auth_timeout", "Refresh deadline exceeds the supported bound.");
    const deadline = authDeadline(refreshTimeoutMs, options.signal);
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
  }, options.signal);
}

const READ_ENDPOINTS = new Set([
  "files/list_folder", "files/list_folder/continue", "files/get_metadata",
  "files/search_v2", "files/search/continue_v2", "users/get_current_account",
  "files/download", "sharing/list_shared_links",
  "files/copy_batch/check_v2", "files/move_batch/check_v2", "files/upload_session/finish_batch/check",
]);

async function fetchWithRetry(url: string, init: RequestInit, options: RequestOptions = {}): Promise<Response> {
  let dispatchedMutation = false;
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
      options.signal?.throwIfAborted();
      dispatchedMutation = !read;
      const pending = fetch(url, { ...init, headers, signal: options.signal });
      const response = options.machine ? await waitForRequest(pending, options.signal) : await pending;
      responseReceivedAt.set(response, Date.now());
      log(`Response: ${response.status}`);
      responseSecrets.set(response, secrets);
      // Mutations never redispatch automatically, including after 401. A refreshed
      // credential is not evidence that an earlier mutation was not applied.
      if (!read) return response;
      if (response.status === 401 && !recovered) {
        recovered = true;
        const refusal = options.machine ? await readAuthRefusal(response, options) : undefined;
        if (!options.machine) void response.body?.cancel().catch(() => {});
        options.signal?.throwIfAborted();
        try { auth = await getCredentialSnapshot(bound, auth); }
        catch (error) {
          // This evidence belongs to the original read, not the token endpoint.
          if (refusal && error instanceof CredentialError && error.code === "auth_error") throw refusal;
          throw error;
        }
        secrets.push(auth.access_token, auth.refresh_token);
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && retries < 5) {
        const retry_after_seconds = retryAfterSeconds(response);
        // An invalid/overflowing provider minimum cannot safely become a shorter retry.
        if (response.headers.has("Retry-After") && retry_after_seconds === undefined) return response;
        const localDelay = response.status === 429 ? 1 : Math.min(2 ** retries, 16);
        const delay = Math.max(localDelay, retry_after_seconds ?? 0);
        retries++;
        void response.body?.cancel().catch(() => {});
        try {
          await retryDelay(delay * 1000, options.signal);
          options.signal?.throwIfAborted();
        }
        catch (error) {
          if (options.machine && options.signal?.aborted) {
            throw new MachineError("cancelled", "Operation cancelled.", {
              outcome: "not_submitted", http_status: response.status, retry_after_seconds,
            });
          }
          throw error;
        }
        continue;
      }
      return response;
    }
  } catch (error) {
    if (options.machine) {
      if (dispatchedMutation) throw new MachineError("unknown_outcome", "Submission may have been applied. Reconcile without replaying.", { outcome: "unknown" });
      if (error instanceof CredentialError || error instanceof MachineError) throw error;
      throw new MachineError(options.signal?.aborted ? "cancelled" : "connection_error", "Read or pre-submission request could not be completed.");
    }
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

// Race even intercepted transports against cancellation; a timeout is never refusal evidence.
export function waitForRequest<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => { cleanup(); reject(new MachineError("cancelled", "Operation cancelled.")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

async function retryDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  const deadline = Math.ceil(performance.now()) + milliseconds;
  let remaining = milliseconds;
  // Runtime timers above signed 32-bit milliseconds can fire immediately instead.
  while (remaining > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await waitForRequest(new Promise<void>(resolve => { timer = setTimeout(resolve, Math.min(remaining, 2147483647)); }), signal);
    } finally { clearTimeout(timer); }
    remaining = Math.ceil(deadline - performance.now());
  }
}

const MACHINE_JSON_LIMIT = 2 * 1024 * 1024;
async function boundedJSON(response: Response, options: RequestOptions): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new MachineError("invalid_response", "Missing Dropbox response body.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await waitForRequest(reader.read(), options.signal);
      if (done) break;
      size += value.length;
      if (size > MACHINE_JSON_LIMIT) throw new MachineError("invalid_response", "Dropbox response exceeded the machine bound.");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function boundedEvidence(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return String(redactError(value, secrets)).slice(0, 512);
  if (Array.isArray(value)) return value.slice(0, 16).map(item => boundedEvidence(item, secrets, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 16).map(([key, item]) => [
    String(redactError(key, secrets)).slice(0, 64), /token|secret|authorization/i.test(key) ? "[REDACTED]" : boundedEvidence(item, secrets, depth + 1),
  ]));
  return value;
}

function retryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get("Retry-After");
  if (raw === null || raw.length > 128) return undefined;
  const value = raw.trim(), received = responseReceivedAt.get(response) ?? Date.now();
  let seconds: number;
  if (/^\d+$/.test(value)) seconds = Number(value);
  else {
    // HTTP's canonical IMF-fixdate, not Date.parse's permissive ISO/natural-language forms.
    if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return undefined;
    const date = Date.parse(value);
    if (!Number.isFinite(date) || new Date(date).toUTCString() !== value) return undefined;
    seconds = Math.max(0, Math.ceil((date - received) / 1000));
  }
  // Reject overflow rather than clamp to a shorter, unsafe provider deadline.
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > (Number.MAX_SAFE_INTEGER - received) / 1000) return undefined;
  return seconds;
}

async function machineResponse(response: Response, options: RequestOptions, mutation: boolean): Promise<unknown> {
  const retry_after_seconds = retryAfterSeconds(response);
  let body: unknown;
  try { body = await boundedJSON(response, options); }
  catch {
    throw new MachineError(mutation ? "unknown_outcome" : "invalid_response", "Dropbox returned an incomplete or invalid response.", {
      outcome: mutation ? "unknown" : "not_submitted", http_status: response.status, retry_after_seconds,
    });
  }
  if (response.ok) return body;
  const secrets = responseSecrets.get(response) ?? [];
  const raw = body as { error?: unknown } | null;
  let dropbox = boundedEvidence(raw?.error, secrets);
  // Preserve nested tags within a fixed diagnostic budget, never an unbounded echo.
  if (JSON.stringify(dropbox ?? null).length > 8192) dropbox = { ".tag": "truncated_error" };
  const parsed = parseDropboxError(boundedEvidence(body, secrets));
  const knownRefusal = [400, 401, 403, 409].includes(response.status) &&
    !!raw?.error && typeof raw.error === "object" && typeof (raw.error as Record<string, unknown>)[".tag"] === "string";
  const authRefusal = response.status === 401 && knownRefusal;
  throw new MachineError(authRefusal ? "auth_error" : mutation && !knownRefusal ? "unknown_outcome" : parsed.code.slice(0, 128),
    authRefusal ? "Dropbox authentication was refused. Reconnect the account." :
      mutation && !knownRefusal ? "Submission may have been applied. Reconcile without replaying." : parsed.message.slice(0, 512), {
      outcome: mutation ? (knownRefusal ? "refused" : "unknown") : "not_submitted",
      http_status: response.status,
      retry_after_seconds,
      request_id: String(redactError(response.headers.get("x-dropbox-request-id") ?? "", secrets)).slice(0, 256),
      dropbox,
    });
}

async function readAuthRefusal(response: Response, options: RequestOptions): Promise<MachineError | undefined> {
  // Optional diagnostics must not consume the entire recovery window on a stalled body.
  const diagnostic = authDeadline(1000, options.signal);
  try { await machineResponse(response, { ...options, signal: diagnostic.signal }, false); }
  catch (error) {
    if (error instanceof MachineError && error.code === "auth_error") return error;
  } finally { diagnostic.close(); }
}

export async function machineRpc<T = unknown>(endpoint: string, body: Record<string, unknown>, options: RequestOptions): Promise<T> {
  if (!options.expectedAccountId) throw new MachineError("invalid_args", "Expected account is required.");
  // No caller can label a mutation as a read to enable automatic replay.
  const mutation = !READ_ENDPOINTS.has(endpoint);
  const request = { ...options, machine: true, retry: mutation ? "mutation" as const : "read" as const };
  const response = await fetchWithRetry(`${RPC_BASE}/${endpoint}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }, request);
  return await machineResponse(response, request, mutation) as T;
}

export function exactPath(path: string): boolean {
  return path.startsWith("/") && path.length > 1 && !path.includes("\0") &&
    !path.split("/").slice(1).some(part => !part || part === "." || part === "..");
}

export function validateMetadata(value: unknown): MachineMetadata {
  const data = value as MachineMetadata | null;
  if (!data || !["file", "folder"].includes(data[".tag"]) || typeof data.id !== "string" || !data.id.startsWith("id:") ||
      typeof data.name !== "string" || typeof data.path_lower !== "string" || !exactPath(data.path_lower) ||
      typeof data.path_display !== "string" || !exactPath(data.path_display) ||
      (data[".tag"] === "file" && (typeof data.rev !== "string" || !data.rev || !Number.isSafeInteger(data.size) || data.size! < 0))) {
    throw new MachineError("invalid_response", "Dropbox metadata is missing identity, version or location evidence.");
  }
  return data;
}

export async function machineMetadata(path: string, options: RequestOptions): Promise<MachineMetadata> {
  if (!(path.startsWith("id:") && path.length > 3) && !exactPath(path)) throw new MachineError("invalid_args", "Metadata requires an ID or exact non-root path.");
  const result = validateMetadata(await machineRpc("files/get_metadata", {
    path, include_has_explicit_shared_members: true,
  }, options));
  if (path.startsWith("id:") && result.id !== path) throw new MachineError("identity_mismatch", "Metadata does not match the requested ID.");
  if (exactPath(path) && result.path_lower !== path.toLowerCase()) throw new MachineError("location_mismatch", "Metadata does not match the requested path.");
  return result;
}

export function isNotFound(error: unknown): boolean {
  if (!(error instanceof MachineError) || error.details.http_status !== 409) return false;
  const data = error.details.dropbox as { ".tag"?: string; path?: { ".tag"?: string } } | undefined;
  return data?.[".tag"] === "path" && data.path?.[".tag"] === "not_found";
}

export async function machineDownload(path: string, options: RequestOptions): Promise<{ metadata: Record<string, unknown>; body: ReadableStream<Uint8Array> }> {
  if (!options.expectedAccountId) throw new MachineError("invalid_args", "Expected account is required.");
  const response = await fetchWithRetry(`${CONTENT_BASE}/files/download`, {
    method: "POST", headers: { "Dropbox-API-Arg": JSON.stringify({ path }) },
  }, { ...options, machine: true, retry: "read" });
  if (!response.ok) await machineResponse(response, options, false);
  try {
    const header = response.headers.get("Dropbox-API-Result");
    if (!header || header.length > 16384 || !response.body) throw new Error();
    const metadata = JSON.parse(header);
    if (!metadata || typeof metadata !== "object") throw new Error();
    return { metadata, body: response.body };
  } catch {
    void response.body?.cancel().catch(() => {});
    throw new MachineError("invalid_response", "Missing or invalid download metadata.");
  }
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
