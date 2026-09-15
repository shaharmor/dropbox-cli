# dropbox-cli

A command-line interface for the Dropbox API. Outputs JSON by default for easy scripting, with an optional `--human` flag for readable output.

Built with [Bun](https://bun.sh) and [Commander.js](https://github.com/tj/commander.js).

## Setup

### Prerequisites

- [Bun](https://bun.sh) runtime
- A Dropbox app (create one at https://www.dropbox.com/developers/apps)
  - Choose **Scoped access**
  - Choose **Full Dropbox** access type
  - Add redirect URI: `http://localhost:8910/callback`

### Install

```sh
bun install
```

### Authenticate

```sh
dropbox-cli auth login
```

On first run you'll be prompted for your app key and secret. A browser window opens for OAuth2 authorization. Credentials and tokens are stored locally in `~/.config/dropbox-cli/`.

## Usage

```
dropbox-cli [options] [command]
```

### Global options

| Option      | Description                          |
|-------------|--------------------------------------|
| `--human`   | Human-readable output instead of JSON |
| `--verbose` | Debug logging to stderr              |
| `-V`        | Show version                         |
| `-h`        | Show help                            |

### Commands

#### `auth` - Manage authentication

```sh
dropbox-cli auth login      # Log in via OAuth2
dropbox-cli auth status     # Check if you're authenticated
dropbox-cli auth logout     # Clear stored tokens

```

#### `bulk-mv` - Batch move files by pattern

Search server-side and move matching files in batches. Handles thousands of files efficiently.

```sh
# Move all files starting with "2024-" from /Photos to /Photos/2024
dropbox-cli bulk-mv "/Photos" "/Photos/2024" --match "2024-"

# Preview what would be moved
dropbox-cli bulk-mv "/Inbox" "/Archive" --match "report" --dry-run

# Move 5 batches in parallel for faster throughput
dropbox-cli bulk-mv "/Photos" "/Photos/2024" --match "2024-" --parallel 5
```

| Option              | Description                            |
|---------------------|----------------------------------------|
| `--match <pattern>` | **(required)** Filename prefix to match |
| `--autorename`      | Auto-rename on conflict                |
| `--dry-run`         | Show what would be moved without moving |
| `--parallel <n>`    | Number of batches to move in parallel (default: 1) |
| `--batch-size <n>`  | Number of files per batch (default: 500)            |

#### `cp` - Copy files

```sh
dropbox-cli cp "/Documents/report.pdf" "/Backup/report.pdf"    # Copy a file
dropbox-cli cp "/a.txt" "/b.txt" "/c.txt" "/Backup"           # Copy multiple files to a folder
```

| Option         | Description             |
|----------------|-------------------------|
| `--autorename` | Auto-rename on conflict |

#### `download` - Download files

```sh
dropbox-cli download "/Documents/report.pdf"             # Download to current directory
dropbox-cli download "/Documents/report.pdf" "./local"   # Download to a specific directory
dropbox-cli download "/Photos/a.jpg" "/Photos/b.jpg" "." # Download multiple files
```

#### `info` - Get file/folder metadata

```sh
dropbox-cli info "/Documents/report.pdf"    # File metadata (size, modified date, hash)
dropbox-cli info "/Photos"                  # Folder metadata
```

#### `ls` - List files and folders

```sh
dropbox-cli ls                            # List root directory
dropbox-cli ls "/Photos"                  # List a specific folder
dropbox-cli ls "/Documents" --limit 10    # Show first 10 entries
dropbox-cli ls "/Projects" --recursive    # List all files recursively
dropbox-cli ls "/Projects" --type folder  # Show only folders
dropbox-cli ls "/Projects" --type file    # Show only files
```

| Option            | Description                          |
|-------------------|--------------------------------------|
| `--limit <count>` | Maximum number of entries to return  |
| `--recursive`     | List files in all subdirectories     |
| `--type <type>`   | Filter by type: `file` or `folder` (cannot be combined with `--limit`) |

#### `mkdir` - Create a folder

```sh
dropbox-cli mkdir "/Projects/new-project"
dropbox-cli mkdir "/Photos/2024/January"
```

#### `mv` - Move or rename files

```sh
dropbox-cli mv "/old-name.txt" "/new-name.txt"              # Rename a file
dropbox-cli mv "/Documents/file.txt" "/Archive/file.txt"    # Move to another folder
dropbox-cli mv "/a.txt" "/b.txt" "/c.txt" "/Archive"        # Move multiple files
```

| Option         | Description             |
|----------------|-------------------------|
| `--autorename` | Auto-rename on conflict |

#### `search` - Search for files and folders

```sh
dropbox-cli search "quarterly report"                  # Search all of Dropbox
dropbox-cli search "*.pdf" --path "/Documents"         # Search within a folder
dropbox-cli search "budget" --limit 5                  # Limit results
```

| Option            | Description                          |
|-------------------|--------------------------------------|
| `--path <path>`   | Limit search to a specific folder    |
| `--limit <count>` | Maximum number of results (default: 100) |

#### `share` - Create a shared link

```sh
dropbox-cli share "/Documents/report.pdf"    # Shareable link for a file
dropbox-cli share "/Photos/Vacation"         # Shareable link for a folder
```

#### `upload` - Upload files

Supports chunked upload for files over 150MB.

```sh
dropbox-cli upload "./report.pdf" "/Documents/report.pdf"          # Upload a single file
dropbox-cli upload "./a.txt" "./b.txt" "/Documents"               # Upload multiple files
dropbox-cli upload "./photo.jpg" "/Photos/pic.jpg" --autorename   # Auto-rename on conflict
```

| Option         | Description             |
|----------------|-------------------------|
| `--autorename` | Auto-rename on conflict |

## Output

All commands output JSON to stdout by default, making it easy to pipe into `jq` or other tools:

```sh
dropbox-cli ls "/Photos" | jq '.[].name'
dropbox-cli info "/Documents/report.pdf" | jq '.size'
```

Use `--human` for readable output (printed to stderr so stdout stays clean):

```sh
dropbox-cli ls "/Photos" --human
```

## Viewer machine contract (protocol 1)

Use `dropbox-cli capabilities` before using the bundled helper. It requires no
credentials and returns `{ "ok": true, "data": { "protocol_version": 1,
"capabilities": [...] } }`. Require the capability names, not just the executable
version: `account-status`, `login-pkce`, `list-page`, `metadata`,
`download-original`, `ensure-directory`, and `move-single`.

These are opt-in contracts. Legacy directory downloads, ordinary `mv`, and batch
or pattern commands are **not** the viewer interface. Launch with argument arrays,
not a shell. All machine reads and moves require `--expected-account` (the Dropbox
account ID, never a token). Each request authenticates from an account-checked,
frozen credential snapshot. Account changes cannot retarget it. `auth status`
returns local account identity without tokens; `auth login --non-interactive`
uses browser PKCE and never prompts on stdin. Missing app configuration is a
structured setup error; the helper does not provision credentials.

### Commands and responses

Examples use placeholder IDs and revisions; do not run them against personal files.

```sh
dropbox-cli ls /Photos --page --page-size 128 --expected-account ACCOUNT
dropbox-cli ls --page --cursor CURSOR --expected-account ACCOUNT
dropbox-cli info id:PHOTO --machine --expected-account ACCOUNT
dropbox-cli download rev:REVISION --expected-id id:PHOTO \
  --output-file /absolute/cache/original.HEIC --expected-account ACCOUNT
dropbox-cli mkdir /Photos/deleted --safe --parent-id id:PHOTOS \
  --expected-account ACCOUNT
dropbox-cli mv id:PHOTO /Photos/deleted/IMG_2.jpg --safe \
  --expected-account ACCOUNT --expected-rev REVISION \
  --expected-source-path /Photos/IMG_2.jpg \
  --source-parent-id id:PHOTOS --destination-parent-id id:DELETED
```

- **`ls --page`** returns `{entries, cursor, has_more}` for exactly one provider
  page, never a final accumulated array. The requested first-page size is 1–2000
  (default 128); Dropbox continuation retains the cursor's paging behavior, so
  callers must allow up to 2000 entries per response. Oversized or malformed
  responses fail rather than silently dropping entries. Do not combine page mode
  with `--limit`, `--recursive`, or `--type`, or a continuation cursor with a path.
  Entries include direct files and folders, including `deleted`; the viewer must
  filter eligible JPEG/JPG/HEIC files and apply stable natural filename ordering.
  Do not publish a new inventory until every continuation succeeds.
- **`info --machine`** accepts an `id:` or exact non-root path and returns metadata
  with `.tag`, ID, name, location, and file revision/size/hash when supplied.
  Sharing fields remain informational. Machine mutations require identified
  non-root parent folders; the Dropbox account root is not a synthetic folder ID.
- **`download --output-file`** requires exactly one `rev:` source, `--expected-id`,
  and an absolute normalized output path. Optional `--expected-hash` checks the
  inventoried Dropbox hash too. The helper checks returned ID/revision/size and,
  when supplied, the Dropbox content hash (SHA-256 of the concatenated SHA-256
  digests of 4 MiB blocks). It streams bytes without whole-file buffering into a
  unique exclusive mode-0600 `.dropbox-UUID.part` file in the existing output
  directory. Only after integrity checks, sync and close does a no-replace hard
  link publish the exact output. Success returns `{id, rev, content_hash?, size,
  local_path}`. It never infers an output basename from remote metadata.
- **`mkdir --safe`** validates the exact parent location/ID, creates without
  autorename, or inspects an existing folder (including a terminal folder conflict
  racing creation). Returns `{created, metadata}`. Existing files and permission
  failures are errors; uncertain creation is not retried or converted to success.
- **`mv --safe`** accepts only one ID source and exact destination. It checks the
  reviewed revision/source location, both parent identities/locations, and target
  vacancy before one `files/move_v2` submission with `autorename: false` and
  `allow_ownership_transfer: false`. File and folder collisions remain unresolved.
  Success is `{outcome: "confirmed", metadata}` only when returned ID/revision/path
  match. Restore uses the same command with reversed parent IDs and recorded paths.
  The viewer owns its selected-folder/`deleted` relationship and durable journal;
  the helper exposes no delete or remote cleanup operation.

### Sharing policy — explicit owner override

The owner directed: **“Just move the image regardless of the sharing state of the deleted folder”.**
Reject and restore do **not** require matching or known sharing contexts. A private source, a separately shared destination, differing inherited
contexts, and absent sharing fields do not independently block a valid move.
Moving into a shared folder may expose the image to that folder's collaborators.
The helper never calls sharing-management/inventory APIs, changes permissions,
requests additional sharing scopes, or enables ownership transfer. This is an
explicit execution override of the earlier sharing-gating design, not compliance
with that design's sharing-conflict acceptance example.

### Outcomes, cancellation, and recovery

Success/error JSON envelopes remain on stdout; optional human/debug diagnostics
remain on stderr. Drain both concurrently. Machine RPC input responses are capped
at 2 MiB before JSON parsing; listing pages at 2000 entries; download metadata
headers at 16 KiB. Error details retain nested Dropbox tags and request IDs when
available, with credentials redacted, depth/field limits and an 8 KiB nested-error
budget. Retain a bounded stdout/stderr budget in the caller (allow room for JSON
pretty-printing), and treat truncation or malformed output as an error, not success.
Invalid command arguments produce bounded JSON without echoing argv or stack traces.

Machine errors add `error.details.outcome`:

| Outcome | Meaning for this invocation |
|---|---|
| `not_submitted` | Validation, authentication, local download or preflight read failed before any mutation dispatch. This is **not** evidence about an older attempt. |
| `refused` | This mutation received a structured Dropbox refusal (HTTP 400/401/403/409). Nested tags, HTTP status and request ID are retained. |
| `unknown` | A dispatched mutation may have applied: transport loss, deadline/cancellation, ambiguous HTTP status, malformed acknowledgment or mismatching returned metadata. Code is `unknown_outcome`. |

Machine errors may also include `error.details.retry_after_seconds`: nonnegative
whole seconds from a valid `Retry-After` delta-seconds value or canonical IMF-fixdate
HTTP-date, relative to response receipt (rounded up for dates; past dates yield 0).
Headers over 128 characters, malformed values and unsafe millisecond-deadline
overflow are omitted, not shortened to a retry cap. This field is **timing evidence
only**: it never changes `outcome` or proves non-application, including for HTTP 429.
Callers must persist the later of this delay and their local backoff, and honor it
across restarts before an otherwise-authorized retry. Missing/invalid headers leave
local backoff in effect; uncertain mutations still require read-only reconciliation.

No machine mutation automatically retries, including on authentication loss, rate
limits, server errors or timeouts. `--timeout` sets a 1–600 second operation deadline
(default 120); SIGINT/SIGTERM cancel. A killed process or lost/malformed stdout
cannot prove that a move was refused. Save attempt identity before launch. After an
unknown outcome, **perform read-only reconciliation, never blindly rerun `mv`**.
A matching destination may confirm the sole outstanding attempt; source presence,
target vacancy, process exit and elapsed time cannot authorize a second submission
or Undo. Without authoritative terminal evidence, keep the operation unresolved.
This CLI does not provide a durable attempt ledger or an exactly-once API.

Dropbox has no atomic expected-revision move. These checks detect known drift but
cannot prevent concurrent external changes between validation and submission.
ID addressing prevents a replacement at the old source pathname from retargeting
the move. Provider no-overwrite and real-account behavior still require separately
authorized tests on disposable cloud fixtures; mocked tests are not that proof.

### Local download boundary

Existing output objects are never replaced. Existing symlinks in the output or any
ancestor are rejected, including dangling links; on macOS supply canonical paths
(e.g. resolve `/tmp` or `/var` aliases before constructing the output). Parents must
already exist. Cancellation/errors remove the staging file when possible and never
publish partial contents. SIGKILL can leave an unpublished `.part`; clean up only
helper-created disposable files inside the viewer's own cache after confirming no
worker owns them. A crash after publication but before acknowledgment may leave a
complete output, which a later download must not overwrite.

The owner chose **standard file safety**: ordinary Bun/Node filesystem operations,
exclusive staging and no-replace publication, with no FFI/native layer. Protection
against concurrent same-user directory/ancestor swaps is explicitly outside this
boundary. Use an application-owned cache, not a directory writable by untrusted
processes; do not claim race-proof ancestor containment.

## Development

```sh
bun run src/index.ts              # Run directly
bun run build                     # Compile to dist/dropbox-cli
bun test                          # Run tests
```
