export interface AppConfig {
  client_id: string;
  client_secret: string;
}

export interface AuthData {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  account_id: string;
  account_email: string;
}

export type CredentialSnapshot = Readonly<AuthData & { generation: string }>;

export interface AuthRequestOptions {
  expectedAccountId?: string;
  refreshTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface RequestOptions extends AuthRequestOptions {
  // Unknown endpoints default to mutation safety; only known reads retry by default.
  retry?: "read" | "mutation";
  // Machine callers receive bounded errors, including mutation dispatch evidence.
  machine?: boolean;
}

export type MutationOutcome = "not_submitted" | "refused" | "unknown";
export interface MachineErrorDetails {
  outcome: MutationOutcome;
  http_status?: number;
  request_id?: string;
  dropbox?: unknown;
}

export class MachineError extends Error {
  constructor(public readonly code: string, message: string,
    public readonly details: MachineErrorDetails = { outcome: "not_submitted" }) {
    super(message);
    this.name = "MachineError";
  }
}

export interface MachineOptions {
  expectedAccount?: string;
  timeout?: string;
}

export interface MachineMetadata {
  ".tag": "file" | "folder";
  id: string;
  name: string;
  path_lower: string;
  path_display: string;
  rev?: string;
  size?: number;
  content_hash?: string;
  // Informational only: moves do not gate on sharing context.
  sharing_info?: Record<string, unknown>;
  has_explicit_shared_members?: boolean;
}

export class CredentialError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

export interface DropboxFile {
  ".tag": "file";
  name: string;
  path_lower: string;
  path_display: string;
  id: string;
  size: number;
  is_downloadable: boolean;
  client_modified: string;
  server_modified: string;
  rev: string;
  content_hash: string;
}

export interface DropboxFolder {
  ".tag": "folder";
  name: string;
  path_lower: string;
  path_display: string;
  id: string;
}

export type DropboxEntry = DropboxFile | DropboxFolder;

export interface ListFolderResult {
  entries: DropboxEntry[];
  cursor: string;
  has_more: boolean;
}

export interface FileMetadata {
  ".tag": "file";
  name: string;
  path_lower: string;
  path_display: string;
  id: string;
  size: number;
  is_downloadable: boolean;
  client_modified: string;
  server_modified: string;
  rev: string;
  content_hash: string;
}

export interface FolderMetadata {
  ".tag": "folder";
  name: string;
  path_lower: string;
  path_display: string;
  id: string;
}

export interface SearchMatch {
  metadata: {
    metadata: DropboxEntry;
  };
}

export interface SearchResult {
  matches: SearchMatch[];
  has_more: boolean;
  cursor?: string;
}

export interface SharedLinkMetadata {
  url: string;
  name: string;
  path_lower: string;
  link_permissions: {
    resolved_visibility: { ".tag": string };
  };
}

export interface BatchResult {
  ".tag": "complete" | "async_job_id";
  entries?: Array<{
    ".tag": "success" | "failure";
    success?: DropboxEntry;
    failure?: { ".tag": string; [key: string]: unknown };
  }>;
  async_job_id?: string;
}
