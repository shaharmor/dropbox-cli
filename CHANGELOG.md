# Changelog

## Unreleased

### Added
- Read-only `stream-link` machine command, advertised by `stream-link`: checks by ID that a reviewed file is still current (same content hash, or same current revision when no hash was recorded), then returns a Dropbox temporary link pinned to the reviewed revision after verifying its ID, revision, hash and `https:` URL. The link never appears in error output.
- Original downloads accept `--progress` to report actual bytes written as bounded-rate JSON lines on stderr, advertised by `download-progress`. The final stdout envelope and integrity checks are unchanged.
- Read-only `thumbnails` machine command: fetch up to 25 revision-pinned 256px JPEG thumbnails per Dropbox batch without downloading originals. Bounded stdin/output, account and identity checks, per-photo failures, and network-denied contract tests.
- Checked `mv-batch` machine contract: bounded stdin, shared parent validation, four-way photo preflight, ID-addressed batch submission, per-photo outcomes and read-only async-job polling without replay.
- Network-denied batch tests for partial failures, drift, lost receipts, account binding, polling, request counts and bounded concurrency.
- Optional bounded `retry_after_seconds` machine-error timing evidence from valid Retry-After headers; it never changes mutation terminality or authorizes replay.
- Versioned viewer capability handshake, explicit bounded nonrecursive listing pages, and account-bound machine metadata.
- Revision-addressed original downloads to an explicit absolute output file, with exclusive streaming staging, identity/size/Dropbox-hash checks, existing-symlink rejection and no-replace publication.
- Opt-in safe single-ID moves and exact destination creation, with account/folder/revision/location checks and structured confirmed, not-submitted, refused or unknown outcomes.
- Isolated process-contract fixtures for paging, stream interruption, local collisions, reject/restore drift, lost acknowledgments, bounded errors and concurrent stdout/stderr pressure.
- Account-bound credential snapshots for CLI transport callers, with noninteractive authentication errors.
- `auth login --non-interactive` and `--timeout` options, plus cancellation on SIGINT/SIGTERM.

### Fixed
- Require and verify Dropbox's content hash for every original download; a response without a valid provider hash fails as `identity_mismatch` instead of publishing unverified bytes.
- Report a throttled or unavailable token endpoint during refresh as `connection_error` instead of `auth_error`, so transient outages do not demand a reconnect.
- Confirm `mv-batch` moves submitted without `contentHash` against the preflight content hash, so a provider-assigned new revision no longer reports `unknown`.
- Report every `mv-batch` entry with an `unknown` outcome under the documented `unknown_outcome` code instead of `invalid_response` or `batch_entry_failed`.
- Keep each `mv-batch` per-entry Dropbox failure tag chain in `error.details.dropbox` so callers can tell a conflict from other refusals.
- Check `mv-batch` parent folders four at a time instead of serially, so batches spanning many folders stay within the request deadline.
- Report `cancelled` instead of `invalid_args` when `mv-batch` or `thumbnails` is cancelled or times out while stdin is still open.
- Report a published original download as successful even if removing its staging file afterwards fails, instead of a `download_error` that made retries fail with `output_exists`.
- Reject `ls --page` responses containing malformed entries (missing identity, location or file revision/size) as `invalid_response`.
- Restore usage help on stderr for bare `dropbox-cli` and command-group invocations such as `dropbox-cli auth`; argument error messages stay suppressed so argv is never echoed.
- Return a thumbnail only when its bytes carry JPEG start and end markers; other payloads report `unavailable`.
- Report human-command failures such as a missing upload file or `ls --limit` with `--type` with their own message under `command_failed` instead of a generic `machine_error`.
- Confirm safe moves when Dropbox assigns a new revision but returns the same file ID, exact destination, size and content hash; return the new revision for subsequent moves/restores. Changed or unprovable content remains unknown without replay.
- Preserve safe mkdir's authoritative creation refusal when follow-up existing-folder verification fails; report `created: false` only after verifying exact folder metadata.
- Honor valid Retry-After minimums on read retries, including HTTP-date and server errors, without timer overflow; preserve status/timing on cancellation and stop internal retries on malformed timing.
- Report structured machine HTTP 401 refusals as stable `auth_error` with sanitized reconnect guidance and bounded provider details, without changing mutation terminality.
- Abort `bulk-mv` before any moves when destination creation fails, except for a structured existing-folder conflict.
- Allow concurrent transport requests to wait through the bounded refresh owner's lifetime, observe cancellation while contending, and reread the account-bound credential snapshot.
- Revalidate normally removed SQLite sidecars during bounded credential acquisition instead of misclassifying journal unlink races as unsafe credentials; keep ownership, permission and link checks fail-closed.
- Keep uncertain machine mutation outcomes distinct from authentication or connection refusals; never automatically replay a submitted move or folder creation.
- Preserve bounded nested Dropbox error tags/request IDs with secret redaction in machine mode; malformed CLI arguments emit JSON rather than unhandled traces.
- Coordinate credential reads, refresh, login, logout, and cancellation across processes using Bun SQLite write transactions and bounded lock waits.
- Persist owner-only credential JSON with atomic replacement and durable generation fences so stale authorization cannot resurrect logout or overwrite a newer login.
- Validate OAuth state, retain PKCE, bind callbacks only to loopback, verify account identity, and close authorization resources on errors, cancellation, or timeout.
- Keep in-flight requests bound to their original account and redact credential echoes in API errors.
- `bulk-mv` now reports why each file failed to move: human output shows the reason per file, and JSON output includes a `failures` list of `{ path, reason }`

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
