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

## Development

```sh
bun run src/index.ts              # Run directly
bun run build                     # Compile to dist/dropbox-cli
bun test                          # Run tests
```
