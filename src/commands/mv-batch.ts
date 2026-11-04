import type { Command } from "commander";
import { posix } from "path";
import {
  exactPath, isContentHash, isId, isNotFound, isText, machineMetadata, machineRpc, pathExists, validateMetadata,
} from "../lib/machine-api";
import { runMachine } from "../lib/output";
import { readStdinJSON } from "../lib/streams";
import {
  CredentialError, MachineError,
  type MachineErrorDetails, type MachineMetadata, type MachineOptions, type MutationOutcome, type RequestOptions,
} from "../types";

/** One reviewed photo move, as recorded by the viewer and supplied on stdin. */
type Move = {
  fileID: string;
  revision: string;
  contentHash?: string;
  size: number;
  sourcePath: string;
  destinationPath: string;
  sourceParentID: string;
  destinationParentID: string;
};

type Entry = {
  fileID: string;
  outcome: "confirmed" | "pending" | MutationOutcome;
  metadata?: MachineMetadata;
  error?: { code: string; message: string; details: MachineErrorDetails };
};

type BatchReport = { entries: (Entry | undefined)[]; async_job_id?: string };

type BatchEntryResult = {
  ".tag"?: string;
  success?: unknown;
  failure?: { ".tag"?: string; relocation_error?: { ".tag"?: string } };
} | null;

const MAX_STDIN_BYTES = 512 * 1024;
const MAX_MOVES = 100;
const MAX_JOB_ID_LENGTH = 4096;
const PREFLIGHT_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

async function readMoves(request: RequestOptions): Promise<Move[]> {
  try {
    const moves = await readStdinJSON(MAX_STDIN_BYTES, request.signal) as Move[];
    if (!Array.isArray(moves) || moves.length < 1 || moves.length > MAX_MOVES) throw new Error();
    if (!moves.every(isValidMove) || !areDisjoint(moves)) throw new Error();
    return moves;
  } catch {
    throw new MachineError("invalid_args", "Batch stdin must contain 1–100 unique, non-overlapping checked moves within 512 KiB.");
  }
}

function isValidMove(move: Move): boolean {
  return !!move && isId(move.fileID) && isText(move.revision) &&
    Number.isSafeInteger(move.size) && move.size >= 0 &&
    (move.contentHash === undefined || isContentHash(move.contentHash)) &&
    isText(move.sourcePath) && exactPath(move.sourcePath) &&
    isText(move.destinationPath) && exactPath(move.destinationPath) &&
    isId(move.sourceParentID) && isId(move.destinationParentID);
}

/** No file, source or destination appears twice, and no move targets another move's source. */
function areDisjoint(moves: Move[]): boolean {
  const ids = new Set(moves.map(move => move.fileID));
  const sources = new Set(moves.map(move => move.sourcePath.toLowerCase()));
  const destinations = new Set(moves.map(move => move.destinationPath.toLowerCase()));
  const unique = ids.size === moves.length && sources.size === moves.length && destinations.size === moves.length;
  return unique && ![...sources].some(path => destinations.has(path));
}

function isJobId(value: unknown): value is string {
  return isText(value) && value.length <= MAX_JOB_ID_LENGTH;
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

function pendingEntry(move: Move): Entry {
  return { fileID: move.fileID, outcome: "pending" };
}

function failedEntry(move: Move, error: unknown, forceUnknown = false): Entry {
  const failure = error instanceof MachineError ? error
    : error instanceof CredentialError ? new MachineError(error.code, "Dropbox connection needs attention.")
    : new MachineError("invalid_response", "Batch could not be verified.");
  const outcome = forceUnknown ? "unknown" : failure.details.outcome;
  // Uncertain moves always carry the documented code, so callers never mistake one for a harmless error.
  const code = outcome === "unknown" ? "unknown_outcome" : failure.code;
  return {
    fileID: move.fileID,
    outcome,
    error: { code, message: "Move could not be confirmed.", details: { ...failure.details, outcome } },
  };
}

function sameContent(metadata: MachineMetadata, move: Move): boolean {
  return metadata[".tag"] === "file" && metadata.id === move.fileID && metadata.size === move.size &&
    (move.contentHash === undefined ? metadata.rev === move.revision : metadata.content_hash === move.contentHash);
}

/** Maps a `complete` batch result back onto the submitted moves, in order. */
function completedEntries(value: unknown, moves: Move[]): Entry[] {
  const result = value as { ".tag"?: string; entries?: unknown[] } | null;
  if (result?.[".tag"] !== "complete" || !Array.isArray(result.entries) || result.entries.length !== moves.length) {
    return moves.map(move => failedEntry(move, null, true));
  }
  return moves.map((move, index) => completedEntry(move, result.entries![index] as BatchEntryResult));
}

function completedEntry(move: Move, item: BatchEntryResult): Entry {
  if (item?.[".tag"] === "success") {
    let metadata: MachineMetadata;
    try {
      metadata = validateMetadata(item.success);
    } catch {
      return failedEntry(move, null, true);
    }
    if (!sameContent(metadata, move) || metadata.path_lower !== move.destinationPath.toLowerCase()) {
      return failedEntry(move, null, true);
    }
    return { fileID: move.fileID, outcome: "confirmed", metadata };
  }
  // internal_error explicitly requires reconciliation in Dropbox's API contract.
  // Unknown tags are not refusal evidence; only identifier-shaped tags are echoed, never provider text.
  const tag = item?.failure?.[".tag"];
  const refused = item?.[".tag"] === "failure" && (tag === "too_many_write_operations" ||
    (tag === "relocation_error" && isText(item.failure?.relocation_error?.[".tag"])));
  return failedEntry(move, new MachineError("batch_entry_failed", "Move did not complete.", {
    outcome: refused ? "refused" : "unknown",
    dropbox: tagChain(item?.failure),
  }));
}

/** The nested `.tag` chain of a Dropbox union (e.g. relocation_error → to → conflict), bounded. */
function tagChain(value: unknown, depth = 0): Record<string, unknown> | undefined {
  const union = value as Record<string, unknown> | null | undefined;
  const tag = union?.[".tag"];
  if (depth >= 8 || typeof tag !== "string" || !/^[a-z0-9_]{1,64}$/.test(tag)) return undefined;
  const nested = tagChain(union![tag], depth + 1);
  return nested ? { ".tag": tag, [tag]: nested } : { ".tag": tag };
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

/** Checks every move, then submits the ones that passed as a single batch. */
async function submit(moves: Move[], request: RequestOptions): Promise<BatchReport> {
  await verifyParentFolders(moves, request);
  const checked = await preflightAll(moves, request);
  const admitted = checked.filter((result): result is Move => !isEntry(result));
  if (!admitted.length) return { entries: checked as Entry[] };

  const submitted = await submitBatch(admitted, request);
  let next = 0;
  return { ...submitted, entries: checked.map(result => isEntry(result) ? result : submitted.entries[next++]) };
}

function isEntry(value: Move | Entry): value is Entry {
  return "outcome" in value;
}

// All folder checks are shared, bounded by the batch, and finish before any move.
async function verifyParentFolders(moves: Move[], request: RequestOptions): Promise<void> {
  const expected = new Map<string, string>();
  for (const move of moves) {
    const parents = [
      [posix.dirname(move.sourcePath).toLowerCase(), move.sourceParentID],
      [posix.dirname(move.destinationPath).toLowerCase(), move.destinationParentID],
    ] as const;
    for (const [path, id] of parents) {
      if (expected.has(path) && expected.get(path) !== id) {
        throw new MachineError("invalid_args", "Conflicting parent identities.");
      }
      expected.set(path, id);
    }
  }
  await runBounded([...expected], async ([path, id]) => {
    const folder = await machineMetadata(path, request);
    if (folder[".tag"] !== "folder" || folder.id !== id) {
      throw new MachineError("folder_drift", "Batch folder identity changed.");
    }
  });
}

/** Runs `task` over `items` with at most four in flight; the first failure stops new dispatch. */
async function runBounded<T>(items: T[], task: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        await task(items[index]!, index);
      } catch (error) {
        next = items.length;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PREFLIGHT_CONCURRENCY, items.length) }, worker));
}

/**
 * Runs `preflight` with bounded concurrency; returns, per input, the checked move to submit or
 * the failed entry that excludes it.
 */
async function preflightAll(moves: Move[], request: RequestOptions): Promise<(Move | Entry)[]> {
  const results: (Move | Entry)[] = [...moves];
  await runBounded(moves, async (move, index) => {
    try {
      results[index] = await preflight(move, request);
    } catch (error) {
      results[index] = failedEntry(move, error);
    }
  });
  return results;
}

/**
 * Verifies one move and returns it pinned to the preflight content hash, so a move that gets a new
 * revision can still be confirmed by unchanged content.
 */
async function preflight(move: Move, request: RequestOptions): Promise<Move> {
  let photo: MachineMetadata;
  try {
    photo = await machineMetadata(move.fileID, request);
  } catch (error) {
    if (isNotFound(error)) throw new MachineError("source_missing", "Reviewed source no longer exists.");
    throw error;
  }
  if (!sameContent(photo, move) || photo.rev !== move.revision) {
    throw new MachineError("revision_changed", "Reviewed content changed.");
  }
  if (photo.path_lower !== move.sourcePath.toLowerCase()) {
    throw new MachineError("location_changed", "Reviewed source moved.");
  }
  if (await pathExists(move.destinationPath, request)) {
    throw new MachineError("destination_conflict", "Destination already exists.");
  }
  return isContentHash(photo.content_hash) ? { ...move, contentHash: photo.content_hash } : move;
}

async function submitBatch(moves: Move[], request: RequestOptions): Promise<{ entries: Entry[]; async_job_id?: string }> {
  try {
    const response = await machineRpc<{ ".tag"?: string; async_job_id?: string }>("files/move_batch_v2", {
      entries: moves.map(move => ({ from_path: move.fileID, to_path: move.destinationPath })),
      autorename: false,
      allow_ownership_transfer: false,
    }, request);
    if (response?.[".tag"] === "async_job_id" && isJobId(response.async_job_id)) {
      return { entries: moves.map(pendingEntry), async_job_id: response.async_job_id };
    }
    return { entries: completedEntries(response, moves) };
  } catch (error) {
    return { entries: moves.map(move => failedEntry(move, error)) };
  }
}

/** Read-only status check of an accepted batch. Never resubmits. */
async function poll(jobId: string, moves: Move[], request: RequestOptions): Promise<BatchReport> {
  if (!isJobId(jobId)) throw new MachineError("invalid_args", "Invalid batch job identity.");
  try {
    const response = await machineRpc<{ ".tag"?: string }>("files/move_batch/check_v2", { async_job_id: jobId }, request);
    if (response?.[".tag"] === "in_progress") return { async_job_id: jobId, entries: moves.map(pendingEntry) };
    return { entries: completedEntries(response, moves) };
  } catch (error) {
    // Dropbox no longer knows an invalid job, so there is nothing left to poll.
    const pollable = !(error instanceof MachineError && error.code === "invalid_async_job_id");
    return {
      entries: moves.map(move => failedEntry(move, error, true)),
      ...(pollable ? { async_job_id: jobId } : {}),
    };
  }
}

export function registerSafeBatchCommand(program: Command): void {
  program
    .command("mv-batch")
    .description("Checked ID-addressed batch moves from bounded JSON on stdin; --job-id only polls an existing batch")
    .requiredOption("--expected-account <id>", "Expected Dropbox account")
    .option("--timeout <seconds>", "Request deadline (1–600 seconds)")
    .option("--job-id <id>", "Poll this job with its exact submitted entries on stdin; never resubmit")
    .action((options: MachineOptions & { jobId?: string }) => runMachine(options, async request => {
      const moves = await readMoves(request);
      return options.jobId !== undefined ? poll(options.jobId, moves, request) : submit(moves, request);
    }));
}
