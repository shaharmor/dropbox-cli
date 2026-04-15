# Dropbox CLI — Design Spec

## Context

We need a standalone CLI tool for interacting with the Dropbox API. The tool targets both human users and AI agents — JSON output by default makes it machine-parseable, while a `--human` flag provides formatted output for interactive use. The CLI must be distributable as a single binary with no runtime dependencies (no Node.js required). It avoids destructive operations (no delete, no overwrite) in this initial version for safety.

## Tech Stack

- **Language:** TypeScript
- **Runtime:** Bun (for development and compilation)
- **CLI Framework:** Commander.js
- **Build:** `bun build --compile` → single native binary
- **Config location:** `~/.dropbox-cli/`

## Project Structure

```
dropbox-cli/
├── src/
│   ├── index.ts              # Entry point, commander setup, command registration
│   ├── commands/
│   │   ├── auth.ts           # auth login, auth logout, auth status
│   │   ├── ls.ts             # List files/folders
│   │   ├── download.ts       # Download file(s)
│   │   ├── upload.ts         # Upload file(s)
│   │   ├── mkdir.ts          # Create folder
│   │   ├── mv.ts             # Move/rename
│   │   ├── cp.ts             # Copy
│   │   ├── search.ts         # Search files
│   │   ├── info.ts           # Get file/folder metadata
│   │   └── share.ts          # Create/list shared links
│   ├── lib/
│   │   ├── api.ts            # Dropbox API client (HTTP calls, auth headers, error handling)
│   │   ├── auth.ts           # OAuth2 flow (browser open, localhost server, token exchange/refresh)
│   │   ├── config.ts         # Read/write ~/.dropbox-cli/config.json and auth.json
│   │   ├── output.ts         # JSON output formatting + --human flag support
│   │   └── logger.ts         # Logging to stderr (--verbose flag)
│   └── types.ts              # Shared TypeScript types
├── package.json
├── tsconfig.json
└── build.ts                  # Build script using bun build --compile
```

## Authentication

### OAuth2 Flow (`dropbox-cli auth login`)

1. Check `~/.dropbox-cli/config.json` for app credentials (client_id, client_secret)
2. If missing, prompt user for their Dropbox app's client ID and client secret
   - Display instructions: "Create a Dropbox app at https://www.dropbox.com/developers/apps"
   - Store in `~/.dropbox-cli/config.json`
3. Generate PKCE code verifier + challenge
4. Open browser to Dropbox OAuth2 authorize URL:
   - `response_type=code`
   - `token_access_type=offline` (to get refresh token)
   - `code_challenge` + `code_challenge_method=S256`
   - `redirect_uri=http://localhost:8910/callback`
5. Start temporary HTTP server on `localhost:8910`
6. Receive auth code at callback
7. Exchange code for access_token + refresh_token via POST to `/oauth2/token`
8. Store tokens in `~/.dropbox-cli/auth.json`
9. Shut down HTTP server, report success

### Token Lifecycle

- Before every API call, check token expiry from `auth.json`
- If expired, refresh using stored refresh_token via `/oauth2/token` with `grant_type=refresh_token`
- Update `auth.json` with new access_token and expiry
- If refresh fails, print error asking user to re-run `auth login`

### Config Files

**`~/.dropbox-cli/config.json`:**
```json
{
  "client_id": "...",
  "client_secret": "..."
}
```

**`~/.dropbox-cli/auth.json`:**
```json
{
  "access_token": "...",
  "refresh_token": "...",
  "expires_at": 1234567890,
  "account_id": "...",
  "account_email": "user@example.com"
}
```

### Other Auth Commands

- `auth status` — Shows: logged in as (email), token expiry, app client_id
- `auth logout` — Deletes `auth.json` (keeps `config.json` with app credentials)

## Commands

### Command Reference

| Command | Description | Dropbox API Endpoint |
|---------|-------------|---------------------|
| `auth login` | Authenticate with Dropbox | `/oauth2/authorize`, `/oauth2/token` |
| `auth logout` | Clear stored tokens | N/A (local) |
| `auth status` | Show auth state | `/users/get_current_account` |
| `ls [path]` | List files/folders (defaults to root `/`). Auto-paginates (follows cursor). | `/files/list_folder`, `/files/list_folder/continue` |
| `upload <local...> <remote>` | Upload file(s) | `/files/upload`, `/files/upload_session/*` |
| `download <remote...> [local]` | Download file(s) | `/files/download` |
| `mkdir <path>` | Create folder | `/files/create_folder_v2` |
| `mv <paths...> <dest>` | Move/rename file(s) | `/files/move_v2`, `/files/move_batch_v2` |
| `cp <paths...> <dest>` | Copy file(s) | `/files/copy_v2`, `/files/copy_batch_v2` |
| `info <path>` | Get file/folder metadata | `/files/get_metadata` |
| `search <query>` | Search files by name/content | `/files/search_v2` |
| `share <path>` | Create shared link | `/sharing/create_shared_link_with_settings` |

### Batch Operations

Commands that accept multiple paths (`mv`, `cp`, `upload`, `download`):
- Single file: uses the single-file API endpoint (e.g., `/files/move_v2`)
- Multiple files: uses the batch endpoint (e.g., `/files/move_batch_v2`)
- Batch endpoints return async job IDs — CLI polls `/check` until complete
- Reports per-file results in JSON output

### Conflict Resolution

Applies to `mv`, `cp`, and `upload`:
- **Default:** fail with error if destination already exists
- `--autorename` flag: Dropbox auto-renames (appends " (1)", " (2)", etc.)

No `--overwrite` flag — no destructive operations in v1.

### Upload Handling

- Files ≤ 150MB: single request via `/files/upload`
- Files > 150MB: chunked upload via upload session:
  1. `/files/upload_session/start`
  2. `/files/upload_session/append_v2` (in chunks)
  3. `/files/upload_session/finish`
- Progress reported to stderr when `--human` flag is set

### Download Handling

- Streams response body directly to file on disk (not buffered in memory)
- If `[local]` path omitted, defaults to current directory with original filename
- Multiple downloads run sequentially, reporting per-file progress

## API Client (`lib/api.ts`)

### Request Patterns

The Dropbox API uses three endpoint styles, all via POST:

1. **RPC-style** — `Content-Type: application/json`, JSON body, JSON response
2. **Upload-style** — `Content-Type: application/octet-stream`, JSON metadata in `Dropbox-API-Arg` header, binary body
3. **Download-style** — JSON in `Dropbox-API-Arg` header, binary response body, metadata in `Dropbox-API-Result` response header

### Error Handling

- Rate limiting (HTTP 429): automatic retry with `Retry-After` header value
- Auth errors (HTTP 401): attempt token refresh, retry once. If still fails, error with re-auth message
- Network errors: report with clear message
- API errors: parse Dropbox error response, return structured error

### Base URLs

- RPC endpoints: `https://api.dropboxapi.com/2/`
- Content endpoints (upload/download): `https://content.dropboxapi.com/2/`

## Output Format

### JSON Output (default)

All commands write to stdout:

**Success:**
```json
{
  "ok": true,
  "data": { ... }
}
```

**Error:**
```json
{
  "ok": false,
  "error": {
    "code": "path/not_found",
    "message": "The path does not exist."
  }
}
```

### Human-Readable Output (`--human`)

- `ls`: formatted table with columns (name, type, size, modified)
- `upload`/`download`: progress indicator
- Other commands: clean status messages

### Exit Codes

- `0` — success
- `1` — general error (API error, invalid arguments)
- `2` — auth error (not logged in, token expired and refresh failed)

## Global Flags

| Flag | Description |
|------|-------------|
| `--human` | Human-readable output instead of JSON |
| `--verbose` | Debug logging to stderr (HTTP requests, token refresh, retries) |
| `--help` | Show help for any command |
| `--version` | Show CLI version |

## Logging

- All log output goes to stderr (never pollutes JSON on stdout)
- `--verbose` enables: HTTP method + URL, response status, token refresh events, retry attempts
- Errors always logged to stderr regardless of verbose flag

## Verification Plan

1. **Build:** `bun build --compile` produces a single binary
2. **Auth:** Run `./dropbox-cli auth login`, complete OAuth flow, verify tokens stored
3. **Commands:** Test each command against a real Dropbox account:
   - `ls /` — list root
   - `mkdir /test-cli` — create folder
   - `upload ./testfile.txt /test-cli/testfile.txt` — upload
   - `ls /test-cli` — verify file appears
   - `info /test-cli/testfile.txt` — check metadata
   - `download /test-cli/testfile.txt ./downloaded.txt` — download
   - `cp /test-cli/testfile.txt /test-cli/copy.txt` — copy
   - `mv /test-cli/copy.txt /test-cli/moved.txt` — move
   - `search "testfile"` — search
   - `share /test-cli/testfile.txt` — create shared link
4. **Batch:** Test multi-file `upload`, `mv`, `cp`, `download`
5. **Flags:** Verify `--human`, `--verbose`, `--autorename` work correctly
6. **Error cases:** Test without auth, with invalid paths, with conflicts
7. **JSON output:** Pipe command output through `jq` to verify valid JSON
