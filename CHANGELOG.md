# Changelog

## Unreleased

### Added
- Optional bounded `retry_after_seconds` machine-error timing evidence from valid Retry-After headers; it never changes mutation terminality or authorizes replay.
- Versioned viewer capability handshake, explicit bounded nonrecursive listing pages, and account-bound machine metadata.
- Revision-addressed original downloads to an explicit absolute output file, with exclusive streaming staging, identity/size/Dropbox-hash checks, existing-symlink rejection and no-replace publication.
- Opt-in safe single-ID moves and exact destination creation, with account/folder/revision/location checks and structured confirmed, not-submitted, refused or unknown outcomes.
- Isolated process-contract fixtures for paging, stream interruption, local collisions, reject/restore drift, lost acknowledgments, bounded errors and concurrent stdout/stderr pressure.
- Account-bound credential snapshots for CLI transport callers, with noninteractive authentication errors.
- `auth login --non-interactive` and `--timeout` options, plus cancellation on SIGINT/SIGTERM.

### Fixed
- Keep uncertain machine mutation outcomes distinct from authentication or connection refusals; never automatically replay a submitted move or folder creation.
- Preserve bounded nested Dropbox error tags/request IDs with secret redaction in machine mode; malformed CLI arguments emit JSON rather than unhandled traces.
- Coordinate credential reads, refresh, login, logout, and cancellation across processes using Bun SQLite write transactions and bounded lock waits.
- Persist owner-only credential JSON with atomic replacement and durable generation fences so stale authorization cannot resurrect logout or overwrite a newer login.
- Validate OAuth state, retain PKCE, bind callbacks only to loopback, verify account identity, and close authorization resources on errors, cancellation, or timeout.
- Keep in-flight requests bound to their original account and redact credential echoes in API errors.

### Changed
- Per explicit owner override, reject/restore do not gate on known or matching sharing contexts, including separately shared `deleted` folders. Sharing metadata is informational; no sharing scopes, permissions or ownership-transfer options are added. Such moves may expose photos to destination collaborators.
- Machine downloads use owner-selected standard filesystem safety, not native/FFI directory anchoring; concurrent same-user ancestor swaps are explicitly outside the supported boundary.
- Separate read retries and authentication recovery; mutations are not automatically redispatched after HTTP errors. App-credential replacement clears existing tokens before publishing the new configuration.

## [1.0.0] - 2026-04-16

### Added
- MIT license
- CI release workflow — builds multi-platform binaries (macOS, Linux, Windows) on tag push
- Comprehensive test suite for all commands and lib modules
- Project README with setup, usage, and command reference
- `--type` flag to `ls` command for filtering by file or folder
- Help text examples to all commands
- `bulk-mv` command for server-side search + batch move
- Pagination to `search` command for large result sets
- `--recursive` flag to `ls` command
- `--limit` flag to `ls` and `search` commands
- `share` and `search` commands
- `mv` and `cp` commands with batch support
- `download` command with streaming file writes
- `upload` command with chunked upload for large files
- `info` and `mkdir` commands
- `ls` command with auto-pagination
- OAuth2 auth flow with login, logout, status commands
- Dropbox API client with auth, retry, rate limiting, and exponential backoff
- Logger and output formatting modules
- Config module for app credentials and auth tokens

### Refactored
- Extract `logHuman()` helper to centralize human-readable output gating
- Bulk-mv now tracks per-file success/failure and reports a `failed` count

### Fixed
- Use `rpcRaw` for folder creation in bulk-mv to handle existing folders
- Use Dropbox terminology (App key/secret) in auth prompts
