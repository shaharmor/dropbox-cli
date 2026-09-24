import type { Command } from "commander";
import { machineThumbnails, waitForRequest } from "../lib/api";
import { runMachine } from "../lib/output";
import { MachineError, type MachineOptions, type RequestOptions } from "../types";

type ThumbnailRequest = { fileID: string; revision: string; contentHash?: string };
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 1024 && !v.includes("\0");

async function readRequests(request: RequestOptions): Promise<ThumbnailRequest[]> {
  const reader = Bun.stdin.stream().getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await waitForRequest(reader.read(), request.signal);
      if (part.done) break;
      size += part.value.length;
      if (size > 64 * 1024) throw new Error();
      chunks.push(part.value);
    }
    const entries = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ThumbnailRequest[];
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 25) throw new Error();
    const ids = new Set<string>();
    for (const e of entries) {
      if (!e || !text(e.fileID) || !e.fileID.startsWith("id:") || e.fileID.length <= 3 || !text(e.revision) ||
          (e.contentHash !== undefined && (typeof e.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(e.contentHash))) || ids.has(e.fileID)) throw new Error();
      ids.add(e.fileID);
    }
    return entries;
  } catch {
    throw new MachineError("invalid_args", "Thumbnail stdin must contain 1–25 unique identities and revisions within 64 KiB.");
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function registerThumbnailsCommand(program: Command): void {
  program.command("thumbnails")
    .description("Fetch only 256px JPEG thumbnails for up to 25 revision-pinned photos from JSON stdin")
    .requiredOption("--expected-account <id>", "Expected Dropbox account")
    .option("--timeout <seconds>", "Request deadline (1–600 seconds)")
    .action((options: MachineOptions) => runMachine(options, async request => {
      const photos = await readRequests(request);
      const response = await machineThumbnails(photos.map(p => p.revision), request) as { entries?: unknown[] } | null;
      if (!Array.isArray(response?.entries) || response.entries.length !== photos.length) {
        throw new MachineError("invalid_response", "Thumbnail batch did not match the requested count.");
      }
      const entries = photos.map((photo, i) => {
        const identity = { fileID: photo.fileID, revision: photo.revision };
        const item = response.entries![i] as { ".tag"?: string; metadata?: { id?: string; rev?: string; content_hash?: string }; thumbnail?: string } | null;
        if (item?.[".tag"] === "success" && item.metadata?.id === photo.fileID && item.metadata.rev === photo.revision &&
            (photo.contentHash === undefined || item.metadata.content_hash === photo.contentHash) &&
            typeof item.thumbnail === "string" && item.thumbnail.length > 0 && item.thumbnail.length <= 87384) {
          const bytes = Buffer.from(item.thumbnail, "base64");
          if (bytes.length <= 65536 && bytes.toString("base64") === item.thumbnail) return { ...identity, thumbnail: item.thumbnail };
        }
        // A thumbnail failure never triggers an original download or a photo decision.
        return { ...identity, error: "unavailable" };
      });
      return { entries };
    }));
}
