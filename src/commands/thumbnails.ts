import type { Command } from "commander";
import { isContentHash, isId, isText, machineThumbnails } from "../lib/machine-api";
import { runMachine } from "../lib/output";
import { readStdinJSON } from "../lib/streams";
import { MachineError, type MachineOptions, type RequestOptions } from "../types";

type ThumbnailRequest = { fileID: string; revision: string; contentHash?: string };

type ThumbnailResult = {
  ".tag"?: string;
  metadata?: { id?: string; rev?: string; content_hash?: string };
  thumbnail?: string;
} | null;

const MAX_STDIN_BYTES = 64 * 1024;
const MAX_PHOTOS = 25;
const MAX_FIELD_LENGTH = 1024;
const MAX_THUMBNAIL_BYTES = 64 * 1024;
const MAX_THUMBNAIL_BASE64_LENGTH = Math.ceil(MAX_THUMBNAIL_BYTES / 3) * 4;

async function readRequests(request: RequestOptions): Promise<ThumbnailRequest[]> {
  try {
    const photos = await readStdinJSON(MAX_STDIN_BYTES, request.signal) as ThumbnailRequest[];
    if (!Array.isArray(photos) || photos.length < 1 || photos.length > MAX_PHOTOS) throw new Error();
    if (!photos.every(isValidRequest)) throw new Error();
    if (new Set(photos.map(photo => photo.fileID)).size !== photos.length) throw new Error();
    return photos;
  } catch {
    throw new MachineError("invalid_args", "Thumbnail stdin must contain 1–25 unique identities and revisions within 64 KiB.");
  }
}

function isValidRequest(photo: ThumbnailRequest): boolean {
  return !!photo && isText(photo.fileID, MAX_FIELD_LENGTH) && isId(photo.fileID) &&
    isText(photo.revision, MAX_FIELD_LENGTH) &&
    (photo.contentHash === undefined || isContentHash(photo.contentHash));
}

/** The thumbnail's base64 JPEG if Dropbox returned it for exactly this photo version. */
function verifiedThumbnail(photo: ThumbnailRequest, item: ThumbnailResult): string | undefined {
  const matches = item?.[".tag"] === "success" &&
    item.metadata?.id === photo.fileID &&
    item.metadata.rev === photo.revision &&
    (photo.contentHash === undefined || item.metadata.content_hash === photo.contentHash);
  const thumbnail = item?.thumbnail;
  if (!matches || typeof thumbnail !== "string" || !thumbnail || thumbnail.length > MAX_THUMBNAIL_BASE64_LENGTH) {
    return undefined;
  }
  // Round-tripping rejects anything that is not canonical base64.
  const bytes = Buffer.from(thumbnail, "base64");
  return bytes.length <= MAX_THUMBNAIL_BYTES && bytes.toString("base64") === thumbnail ? thumbnail : undefined;
}

export function registerThumbnailsCommand(program: Command): void {
  program
    .command("thumbnails")
    .description("Fetch only 256px JPEG thumbnails for up to 25 revision-pinned photos from JSON stdin")
    .requiredOption("--expected-account <id>", "Expected Dropbox account")
    .option("--timeout <seconds>", "Request deadline (1–600 seconds)")
    .action((options: MachineOptions) => runMachine(options, async request => {
      const photos = await readRequests(request);
      const response = await machineThumbnails(photos.map(photo => photo.revision), request) as
        { entries?: unknown[] } | null;
      if (!Array.isArray(response?.entries) || response.entries.length !== photos.length) {
        throw new MachineError("invalid_response", "Thumbnail batch did not match the requested count.");
      }
      const entries = photos.map((photo, index) => {
        const identity = { fileID: photo.fileID, revision: photo.revision };
        const thumbnail = verifiedThumbnail(photo, response.entries![index] as ThumbnailResult);
        // A thumbnail failure never triggers an original download or a photo decision.
        return thumbnail ? { ...identity, thumbnail } : { ...identity, error: "unavailable" };
      });
      return { entries };
    }));
}
