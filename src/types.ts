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
