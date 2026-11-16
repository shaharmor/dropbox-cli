import { log } from "./logger";
import { CONTENT_BASE, RPC_BASE, fetchWithRetry, readError, responseError } from "./transport";
import { CommandError, type RequestOptions } from "../types";

export type RawResult = { ok: boolean; status: number; data: unknown };

async function failResponse(response: Response): Promise<never> {
  // A refused token needs no body: its error is fixed.
  const body = response.status === 401 ? undefined : await readError(response);
  throw responseError(response.status, body);
}

async function rawResult(response: Response): Promise<RawResult> {
  const data = response.ok ? await response.json().catch(() => null) : await readError(response);
  return { ok: response.ok, status: response.status, data };
}

export async function rpc<T = unknown>(
  endpoint: string,
  body: Record<string, unknown> = {},
  options: RequestOptions = {},
): Promise<T> {
  const response = await fetchWithRetry(`${RPC_BASE}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, options);

  if (!response.ok) await failResponse(response);

  return response.json() as Promise<T>;
}

export async function rpcRaw(endpoint: string, body: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<RawResult> {
  const response = await fetchWithRetry(`${RPC_BASE}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, options);

  return rawResult(response);
}

function sendContent(
  endpoint: string,
  metadata: Record<string, unknown>,
  content: Blob,
  options: RequestOptions,
): Promise<Response> {
  return fetchWithRetry(`${CONTENT_BASE}/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify(metadata),
    },
    body: content,
  }, options);
}

export async function contentUpload<T = unknown>(
  endpoint: string,
  metadata: Record<string, unknown>,
  content: Blob,
  options: RequestOptions = {}
): Promise<T> {
  const response = await sendContent(endpoint, metadata, content, options);

  if (!response.ok) await failResponse(response);

  return response.json() as Promise<T>;
}

export async function contentUploadRaw(
  endpoint: string,
  metadata: Record<string, unknown>,
  content: Blob,
  options: RequestOptions = {}
): Promise<RawResult> {
  return rawResult(await sendContent(endpoint, metadata, content, options));
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
    throw new CommandError("batch_error", `${prefix}Batch job failed: ${result[".tag"]}`);
  }
}
