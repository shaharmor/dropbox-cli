# Changelog

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
