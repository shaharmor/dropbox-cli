import { CONTENT_BASE, READ_ENDPOINTS, RPC_BASE, fetchWithRetry, machineResponse } from "./transport";
import { MachineError, type MachineMetadata, type RequestOptions } from "../types";

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

export function isText(value: unknown, maxLength = Infinity): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !value.includes("\0");
}

export function isId(value: unknown): value is string {
  return isText(value) && value.startsWith("id:") && value.length > 3;
}

export function isContentHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** An absolute, non-root path without empty, `.` or `..` segments. */
export function exactPath(path: string): boolean {
  return path.startsWith("/") && path.length > 1 && !path.includes("\0") &&
    !path.split("/").slice(1).some(part => !part || part === "." || part === "..");
}

export function validateMetadata(value: unknown): MachineMetadata {
  const data = value as MachineMetadata | null;
  const valid = !!data && ["file", "folder"].includes(data[".tag"]) &&
    typeof data.id === "string" && data.id.startsWith("id:") &&
    typeof data.name === "string" &&
    typeof data.path_lower === "string" && exactPath(data.path_lower) &&
    typeof data.path_display === "string" && exactPath(data.path_display) &&
    (data[".tag"] !== "file" ||
      (typeof data.rev === "string" && data.rev.length > 0 && Number.isSafeInteger(data.size) && data.size! >= 0));
  if (!valid) {
    throw new MachineError("invalid_response", "Dropbox metadata is missing identity, version or location evidence.");
  }
  return data;
}

// ---------------------------------------------------------------------------
// Dropbox error tags
// ---------------------------------------------------------------------------

type PathError = { ".tag"?: string; path?: { ".tag"?: string; conflict?: { ".tag"?: string } } };

export function isNotFound(error: unknown): boolean {
  if (!(error instanceof MachineError) || error.details.http_status !== 409) return false;
  const data = error.details.dropbox as PathError | undefined;
  return data?.[".tag"] === "path" && data.path?.[".tag"] === "not_found";
}

/** Whether a Dropbox `error` object says a folder already occupies the path. */
export function isFolderConflict(dropboxError: unknown): boolean {
  const error = dropboxError as PathError | null | undefined;
  return error?.[".tag"] === "path" && error.path?.[".tag"] === "conflict" &&
    error.path.conflict?.[".tag"] === "folder";
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

function requireAccount(options: RequestOptions): void {
  if (!options.expectedAccountId) throw new MachineError("invalid_args", "Expected account is required.");
}

export async function machineRpc<T = unknown>(
  endpoint: string,
  body: Record<string, unknown>,
  options: RequestOptions,
): Promise<T> {
  requireAccount(options);
  // No caller can label a mutation as a read to enable automatic replay.
  const mutation = !READ_ENDPOINTS.has(endpoint);
  const request: RequestOptions = { ...options, machine: true, retry: mutation ? "mutation" : "read" };
  const response = await fetchWithRetry(`${RPC_BASE}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, request);
  return await machineResponse(response, request, mutation) as T;
}

/** Metadata for an `id:` or exact path, verified to describe exactly what was requested. */
export async function machineMetadata(path: string, options: RequestOptions): Promise<MachineMetadata> {
  const byId = isId(path);
  const lowerPath = path.toLowerCase();
  if (!byId && !exactPath(path)) throw new MachineError("invalid_args", "Metadata requires an ID or exact non-root path.");
  const result = validateMetadata(await machineRpc("files/get_metadata", {
    path, include_has_explicit_shared_members: true,
  }, options));
  if (byId && result.id !== path) {
    throw new MachineError("identity_mismatch", "Metadata does not match the requested ID.");
  }
  if (!byId && result.path_lower !== lowerPath) {
    throw new MachineError("location_mismatch", "Metadata does not match the requested path.");
  }
  return result;
}

export async function pathExists(path: string, options: RequestOptions): Promise<boolean> {
  try {
    await machineMetadata(path.toLowerCase(), options);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export async function machineThumbnails(revisions: string[], options: RequestOptions): Promise<unknown> {
  requireAccount(options);
  const request: RequestOptions = { ...options, machine: true, retry: "read" };
  const entries = revisions.map(revision => ({
    path: `rev:${revision}`, format: "jpeg", size: "w256h256", mode: "strict",
  }));
  const response = await fetchWithRetry(`${CONTENT_BASE}/files/get_thumbnail_batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries }),
  }, request);
  return machineResponse(response, request, false, 4 * 1024 * 1024);
}

export async function machineDownload(
  path: string,
  options: RequestOptions,
): Promise<{ metadata: Record<string, unknown>; body: ReadableStream<Uint8Array> }> {
  requireAccount(options);
  const response = await fetchWithRetry(`${CONTENT_BASE}/files/download`, {
    method: "POST",
    headers: { "Dropbox-API-Arg": JSON.stringify({ path }) },
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
