import type { Command } from "commander";
import { posix } from "path";
import { exactPath, isNotFound, machineMetadata, machineRpc, validateMetadata, waitForRequest } from "../lib/api";
import { runMachine } from "../lib/output";
import { CredentialError, MachineError, type MachineMetadata, type MachineOptions, type RequestOptions } from "../types";

type Move = {
  fileID: string; revision: string; contentHash?: string; size: number;
  sourcePath: string; destinationPath: string; sourceParentID: string; destinationParentID: string;
};
type Entry = { fileID: string; outcome: "confirmed" | "pending" | "not_submitted" | "refused" | "unknown";
  metadata?: MachineMetadata; error?: { code: string; message: string; details: MachineError["details"] } };
const MAX_BYTES = 512 * 1024;
const validText = (v: unknown): v is string => typeof v === "string" && v.length > 0 && !v.includes("\0");
const validID = (v: unknown): v is string => validText(v) && v.startsWith("id:") && v.length > 3;

async function readMoves(request: RequestOptions): Promise<Move[]> {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await waitForRequest(reader.read(), request.signal);
      if (part.done) break;
      size += part.value.length;
      if (size > MAX_BYTES) throw new Error();
      chunks.push(part.value);
    }
    const entries = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Move[];
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 100) throw new Error();
    const ids = new Set<string>(), sources = new Set<string>(), destinations = new Set<string>();
    for (const e of entries) {
      if (!e || !validID(e.fileID) || !validText(e.revision) || !Number.isSafeInteger(e.size) || e.size < 0 ||
          (e.contentHash !== undefined && (typeof e.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(e.contentHash))) ||
          !validText(e.sourcePath) || !exactPath(e.sourcePath) || !validText(e.destinationPath) || !exactPath(e.destinationPath) ||
          !validID(e.sourceParentID) || !validID(e.destinationParentID) || ids.has(e.fileID) ||
          sources.has(e.sourcePath.toLowerCase()) || destinations.has(e.destinationPath.toLowerCase())) throw new Error();
      ids.add(e.fileID); sources.add(e.sourcePath.toLowerCase()); destinations.add(e.destinationPath.toLowerCase());
    }
    if ([...sources].some(path => destinations.has(path))) throw new Error();
    return entries;
  } catch {
    throw new MachineError("invalid_args", "Batch stdin must contain 1–100 unique, non-overlapping checked moves within 512 KiB.");
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function failure(move: Move, error: unknown, forceUnknown = false): Entry {
  const e = error instanceof MachineError ? error : error instanceof CredentialError
    ? new MachineError(error.code, "Dropbox connection needs attention.")
    : new MachineError("invalid_response", "Batch could not be verified.");
  const outcome = forceUnknown ? "unknown" : e.details.outcome;
  return { fileID: move.fileID, outcome, error: { code: e.code, message: "Move could not be confirmed.", details: { ...e.details, outcome } } };
}
function sameContent(metadata: MachineMetadata, move: Move): boolean {
  return metadata[".tag"] === "file" && metadata.id === move.fileID && metadata.size === move.size &&
    (move.contentHash === undefined ? metadata.rev === move.revision : metadata.content_hash === move.contentHash);
}
function completion(value: unknown, moves: Move[]): Entry[] {
  const response = value as { ".tag"?: string; entries?: unknown[] } | null;
  if (response?.[".tag"] !== "complete" || !Array.isArray(response.entries) || response.entries.length !== moves.length) {
    return moves.map(e => failure(e, null, true));
  }
  return moves.map((move, index) => {
    const item = response.entries![index] as { ".tag"?: string; success?: unknown; failure?: { ".tag"?: string; relocation_error?: { ".tag"?: string } } } | null;
    if (item?.[".tag"] === "success") {
      try {
        const metadata = validateMetadata(item.success);
        if (!sameContent(metadata, move) || metadata.path_lower !== move.destinationPath.toLowerCase()) throw new Error();
        return { fileID: move.fileID, outcome: "confirmed", metadata };
      } catch { return failure(move, null, true); }
    }
    // internal_error explicitly requires reconciliation in Dropbox's API contract.
    // Unknown tags are not refusal evidence; never echo untrusted provider text.
    const tag = item?.failure?.[".tag"];
    const refused = item?.[".tag"] === "failure" && (tag === "too_many_write_operations" ||
      (tag === "relocation_error" && validText(item.failure?.relocation_error?.[".tag"])));
    return failure(move, new MachineError("batch_entry_failed", "Move did not complete.", {
      outcome: refused ? "refused" : "unknown",
    }));
  });
}

async function submit(moves: Move[], request: RequestOptions) {
  // All folder checks are shared, bounded by the batch, and finish before any move.
  const parents = new Map<string, string>();
  for (const e of moves) for (const [path, id] of [[posix.dirname(e.sourcePath).toLowerCase(), e.sourceParentID], [posix.dirname(e.destinationPath).toLowerCase(), e.destinationParentID]] as const) {
    if (parents.has(path) && parents.get(path) !== id) throw new MachineError("invalid_args", "Conflicting parent identities.");
    parents.set(path, id);
  }
  for (const [path, id] of parents) {
    const folder = await machineMetadata(path, request);
    if (folder[".tag"] !== "folder" || folder.id !== id) throw new MachineError("folder_drift", "Batch folder identity changed.");
  }
  const results: (Entry | undefined)[] = new Array(moves.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, moves.length) }, async () => {
    while (next < moves.length) {
      const index = next++, e = moves[index]!;
      try {
        let photo: MachineMetadata;
        try { photo = await machineMetadata(e.fileID, request); }
        catch (error) {
          if (isNotFound(error)) throw new MachineError("source_missing", "Reviewed source no longer exists.");
          throw error;
        }
        if (!sameContent(photo, e) || photo.rev !== e.revision) throw new MachineError("revision_changed", "Reviewed content changed.");
        if (photo.path_lower !== e.sourcePath.toLowerCase()) throw new MachineError("location_changed", "Reviewed source moved.");
        try {
          await machineMetadata(e.destinationPath.toLowerCase(), request);
          throw new MachineError("destination_conflict", "Destination already exists.");
        } catch (error) { if (!isNotFound(error)) throw error; }
      } catch (error) { results[index] = failure(e, error); }
    }
  }));
  const admitted = moves.filter((_, index) => !results[index]);
  let job: string | undefined;
  if (admitted.length) {
    let submitted: Entry[];
    try {
      const response = await machineRpc<{ ".tag"?: string; async_job_id?: string }>("files/move_batch_v2", {
        entries: admitted.map(e => ({ from_path: e.fileID, to_path: e.destinationPath })), autorename: false, allow_ownership_transfer: false,
      }, request);
      if (response?.[".tag"] === "async_job_id" && validText(response.async_job_id) && response.async_job_id.length <= 4096) {
        job = response.async_job_id;
        submitted = admitted.map(e => ({ fileID: e.fileID, outcome: "pending" }));
      } else { submitted = completion(response, admitted); }
    } catch (error) { submitted = admitted.map(e => failure(e, error)); }
    let index = 0;
    for (let i = 0; i < moves.length; i++) if (!results[i]) results[i] = submitted[index++];
  }
  return { entries: results, ...(job ? { async_job_id: job } : {}) };
}

export function registerSafeBatchCommand(program: Command): void {
  program.command("mv-batch")
    .description("Checked ID-addressed batch moves from bounded JSON on stdin; --job-id only polls an existing batch")
    .requiredOption("--expected-account <id>", "Expected Dropbox account")
    .option("--timeout <seconds>", "Request deadline (1–600 seconds)")
    .option("--job-id <id>", "Poll this job with its exact submitted entries on stdin; never resubmit")
    .action((options: MachineOptions & {jobId?: string}) => runMachine(options, async request => {
      const moves = await readMoves(request);
      if (options.jobId !== undefined) {
        if (!validText(options.jobId) || options.jobId.length > 4096) throw new MachineError("invalid_args", "Invalid batch job identity.");
        try {
          const response = await machineRpc<{ ".tag"?: string }>("files/move_batch/check_v2", {async_job_id: options.jobId}, request);
          if (response?.[".tag"] === "in_progress") return { async_job_id: options.jobId, entries: moves.map(e => ({fileID:e.fileID,outcome:"pending"})) };
          return { entries: completion(response, moves) };
        } catch (error) {
          return { entries: moves.map(e => failure(e, error, true)),
            ...(error instanceof MachineError && error.code === "invalid_async_job_id" ? {} : { async_job_id: options.jobId }) };
        }
      }
      return submit(moves, request);
    }));
}
