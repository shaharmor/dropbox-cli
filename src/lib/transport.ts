import { authDeadline } from "./auth-coordination";
import { getCredentialSnapshot } from "./credentials";
import { log } from "./logger";
import { printError } from "./output";
import { readBounded, waitForRequest } from "./streams";
import {
  CredentialError, MachineError,
  type CredentialSnapshot, type MachineErrorDetails, type RequestOptions,
} from "../types";

export const RPC_BASE = "https://api.dropboxapi.com/2";
export const CONTENT_BASE = "https://content.dropboxapi.com/2";

// Only these endpoints may be retried automatically. Anything else is treated as a mutation.
export const READ_ENDPOINTS = new Set([
  "files/list_folder", "files/list_folder/continue", "files/get_metadata",
  "files/search_v2", "files/search/continue_v2", "users/get_current_account",
  "files/download", "files/get_thumbnail_batch", "files/get_temporary_link", "sharing/list_shared_links",
  "files/copy_batch/check_v2", "files/move_batch/check_v2", "files/upload_session/finish_batch/check",
]);

const MAX_READ_RETRIES = 5;
const MAX_TIMER_MS = 2147483647;
const MACHINE_JSON_LIMIT = 2 * 1024 * 1024;
export const AUTH_REFUSED = "Dropbox authentication was refused. Reconnect the account.";
const UNKNOWN_OUTCOME = "Submission may have been applied. Reconcile without replaying.";

// Per-response context needed later to redact errors and interpret Retry-After.
const responseSecrets = new WeakMap<Response, readonly string[]>();
const responseReceivedAt = new WeakMap<Response, number>();

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Sends one authenticated request. Reads retry on 429/5xx and recover once from a 401.
 * Mutations are dispatched exactly once: a lost response never authorizes a replay.
 */
export async function fetchWithRetry(url: string, init: RequestInit, options: RequestOptions = {}): Promise<Response> {
  let submittedMutation = false;
  try {
    const auth = await getCredentialSnapshot(options);
    if (isReadRequest(url, options)) return await readWithRetry(url, init, auth, options);

    options.signal?.throwIfAborted();
    submittedMutation = true;
    // Mutations never redispatch automatically, including after 401. A refreshed
    // credential is not evidence that an earlier mutation was not applied.
    return await send(url, init, auth, [auth.access_token, auth.refresh_token], options);
  } catch (error) {
    return transportFailure(error, options, submittedMutation);
  }
}

function isReadRequest(url: string, options: RequestOptions): boolean {
  const endpoint = url.replace(`${RPC_BASE}/`, "").replace(`${CONTENT_BASE}/`, "");
  return (options.retry ?? (READ_ENDPOINTS.has(endpoint) ? "read" : "mutation")) === "read";
}

async function readWithRetry(
  url: string,
  init: RequestInit,
  auth: CredentialSnapshot,
  options: RequestOptions,
): Promise<Response> {
  // Shared by every attempt's response so later redaction also covers refreshed tokens.
  const secrets = [auth.access_token, auth.refresh_token];
  // Pin the original account even if the caller did not supply an expected account.
  const pinned = { ...options, expectedAccountId: auth.account_id };
  let retries = 0;
  let reauthenticated = false;
  while (true) {
    options.signal?.throwIfAborted();
    const response = await send(url, init, auth, secrets, options);

    if (response.status === 401 && !reauthenticated) {
      reauthenticated = true;
      auth = await reauthenticate(response, auth, pinned, options);
      secrets.push(auth.access_token, auth.refresh_token);
      continue;
    }

    if ((response.status === 429 || response.status >= 500) && retries < MAX_READ_RETRIES) {
      const retryAfter = retryAfterSeconds(response);
      // An invalid/overflowing provider minimum cannot safely become a shorter retry.
      if (response.headers.has("Retry-After") && retryAfter === undefined) return response;
      const backoff = response.status === 429 ? 1 : Math.min(2 ** retries, 16);
      retries++;
      void response.body?.cancel().catch(() => {});
      await waitBeforeRetry(Math.max(backoff, retryAfter ?? 0), response.status, retryAfter, options);
      continue;
    }

    return response;
  }
}

async function send(
  url: string,
  init: RequestInit,
  auth: CredentialSnapshot,
  secrets: readonly string[],
  options: RequestOptions,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${auth.access_token}`);
  log(`POST ${url}`);
  const pending = fetch(url, { ...init, headers, signal: options.signal });
  const response = options.machine ? await waitForRequest(pending, options.signal) : await pending;
  responseReceivedAt.set(response, Date.now());
  responseSecrets.set(response, secrets);
  log(`Response: ${response.status}`);
  return response;
}

async function reauthenticate(
  response: Response,
  rejected: CredentialSnapshot,
  pinned: RequestOptions,
  options: RequestOptions,
): Promise<CredentialSnapshot> {
  const refusal = options.machine ? await readAuthRefusal(response, options) : undefined;
  if (!options.machine) void response.body?.cancel().catch(() => {});
  options.signal?.throwIfAborted();
  try {
    return await getCredentialSnapshot(pinned, rejected);
  } catch (error) {
    // This evidence belongs to the original read, not the token endpoint.
    if (refusal && error instanceof CredentialError && error.code === "auth_error") throw refusal;
    throw error;
  }
}

async function readAuthRefusal(response: Response, options: RequestOptions): Promise<MachineError | undefined> {
  // Optional diagnostics must not consume the entire recovery window on a stalled body.
  const diagnostic = authDeadline(1000, options.signal);
  try {
    await machineResponse(response, { ...options, signal: diagnostic.signal }, false);
  } catch (error) {
    if (error instanceof MachineError && error.code === "auth_error") return error;
  } finally {
    diagnostic.close();
  }
}

async function waitBeforeRetry(
  seconds: number,
  status: number,
  retryAfter: number | undefined,
  options: RequestOptions,
): Promise<void> {
  try {
    await sleep(seconds * 1000, options.signal);
    options.signal?.throwIfAborted();
  } catch (error) {
    if (options.machine && options.signal?.aborted) {
      throw new MachineError("cancelled", "Operation cancelled.", {
        outcome: "not_submitted", http_status: status, retry_after_seconds: retryAfter,
      });
    }
    throw error;
  }
}

async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  const deadline = Math.ceil(performance.now()) + milliseconds;
  let remaining = milliseconds;
  // Runtime timers above signed 32-bit milliseconds can fire immediately instead.
  while (remaining > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await waitForRequest(new Promise<void>(resolve => {
        timer = setTimeout(resolve, Math.min(remaining, MAX_TIMER_MS));
      }), signal);
    } finally {
      clearTimeout(timer);
    }
    remaining = Math.ceil(deadline - performance.now());
  }
}

function transportFailure(error: unknown, options: RequestOptions, submittedMutation: boolean): never {
  if (options.machine) {
    if (submittedMutation) throw new MachineError("unknown_outcome", UNKNOWN_OUTCOME, { outcome: "unknown" });
    if (error instanceof CredentialError || error instanceof MachineError) throw error;
    throw new MachineError(
      options.signal?.aborted ? "cancelled" : "connection_error",
      "Read or pre-submission request could not be completed.",
    );
  }
  if (error instanceof CredentialError) printError(error.code, error.message, 2);
  printError("connection_error", "Dropbox request could not be completed.");
}

/** Seconds from a valid Retry-After header, or undefined if absent, malformed or overflowing. */
function retryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get("Retry-After");
  if (raw === null || raw.length > 128) return undefined;
  const value = raw.trim();
  const received = responseReceivedAt.get(response) ?? Date.now();
  let seconds: number;
  if (/^\d+$/.test(value)) {
    seconds = Number(value);
  } else {
    // HTTP's canonical IMF-fixdate, not Date.parse's permissive ISO/natural-language forms.
    const imfFixdate = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
    if (!imfFixdate.test(value)) return undefined;
    const date = Date.parse(value);
    if (!Number.isFinite(date) || new Date(date).toUTCString() !== value) return undefined;
    seconds = Math.max(0, Math.ceil((date - received) / 1000));
  }
  // Reject overflow rather than clamp to a shorter, unsafe provider deadline.
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > (Number.MAX_SAFE_INTEGER - received) / 1000) {
    return undefined;
  }
  return seconds;
}

// ---------------------------------------------------------------------------
// Error bodies
// ---------------------------------------------------------------------------

function redactText(text: string, secrets: readonly string[]): string {
  for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
  return text;
}

function redact(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secrets)]));
  }
  return value;
}

/** The response's JSON error body with any credentials from the request redacted. */
export async function readError(response: Response): Promise<unknown> {
  const body = await response.json().catch(() => null);
  return redact(body, responseSecrets.get(response) ?? []);
}

export function parseDropboxError(body: unknown): { code: string; message: string } {
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

// ---------------------------------------------------------------------------
// Machine responses
// ---------------------------------------------------------------------------

/**
 * Returns the bounded JSON body of a successful response, or throws a MachineError whose
 * `outcome` tells the caller whether a mutation was refused or may have been applied.
 */
export async function machineResponse(
  response: Response,
  options: RequestOptions,
  mutation: boolean,
  limit = MACHINE_JSON_LIMIT,
): Promise<unknown> {
  const retryAfter = retryAfterSeconds(response);
  let body: unknown;
  try {
    if (!response.body) throw new Error("Missing Dropbox response body.");
    body = JSON.parse((await readBounded(response.body, limit, options.signal)).toString("utf8"));
  } catch {
    throw new MachineError(
      mutation ? "unknown_outcome" : "invalid_response",
      "Dropbox returned an incomplete or invalid response.",
      { outcome: mutation ? "unknown" : "not_submitted", http_status: response.status, retry_after_seconds: retryAfter },
    );
  }
  if (response.ok) return body;
  throw machineHttpError(response, body, mutation, retryAfter);
}

function machineHttpError(
  response: Response,
  body: unknown,
  mutation: boolean,
  retryAfter: number | undefined,
): MachineError {
  const secrets = responseSecrets.get(response) ?? [];
  const error = (body as { error?: unknown } | null)?.error;
  // Only a structured Dropbox error on a client-error status proves the request was refused.
  const refused = [400, 401, 403, 409].includes(response.status) &&
    !!error && typeof error === "object" && typeof (error as Record<string, unknown>)[".tag"] === "string";

  const details: MachineErrorDetails = {
    outcome: mutation ? (refused ? "refused" : "unknown") : "not_submitted",
    http_status: response.status,
    retry_after_seconds: retryAfter,
    request_id: redactText(response.headers.get("x-dropbox-request-id") ?? "", secrets).slice(0, 256),
    dropbox: errorEvidence(error, secrets),
  };
  if (response.status === 401 && refused) return new MachineError("auth_error", AUTH_REFUSED, details);
  if (mutation && !refused) return new MachineError("unknown_outcome", UNKNOWN_OUTCOME, details);
  const { code, message } = parseDropboxError(boundedEvidence(body, secrets));
  return new MachineError(code.slice(0, 128), message.slice(0, 512), details);
}

// Preserve nested tags within a fixed diagnostic budget, never an unbounded echo.
function errorEvidence(error: unknown, secrets: readonly string[]): unknown {
  const evidence = boundedEvidence(error, secrets);
  return JSON.stringify(evidence ?? null).length > 8192 ? { ".tag": "truncated_error" } : evidence;
}

function boundedEvidence(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return redactText(value, secrets).slice(0, 512);
  if (Array.isArray(value)) return value.slice(0, 16).map(item => boundedEvidence(item, secrets, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 16).map(([key, item]) => [
      redactText(key, secrets).slice(0, 64),
      /token|secret|authorization/i.test(key) ? "[REDACTED]" : boundedEvidence(item, secrets, depth + 1),
    ]));
  }
  return value;
}
