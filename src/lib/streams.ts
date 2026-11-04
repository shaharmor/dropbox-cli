import { MachineError } from "../types";

// Race even intercepted transports against cancellation; a timeout is never refusal evidence.
export function waitForRequest<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(new MachineError("cancelled", "Operation cancelled."));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    pending.then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); },
    );
  });
}

/** Reads a whole stream, failing once it exceeds `limit` bytes or the signal aborts. */
export async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await waitForRequest(reader.read(), signal);
      if (done) return Buffer.concat(chunks, size);
      size += value.length;
      if (size > limit) throw new Error("Stream exceeded its size bound.");
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readStdinJSON(limit: number, signal?: AbortSignal): Promise<unknown> {
  const input = await readBounded(Bun.stdin.stream(), limit, signal);
  return JSON.parse(input.toString("utf8"));
}
