# Agent Instructions

## Public Repository: Security & Privacy

This repository is **public**. Everything you commit or push (code, tests, docs, plans, commit messages, PR descriptions, release notes) can be seen by anyone and stays in git history forever. Treat every commit as a publication.

### Never commit

- **Credentials:** Dropbox app keys/secrets (`client_id`, `client_secret`), access/refresh tokens, authorization codes, API keys, passwords, private keys, or any other secret, even expired, revoked, or "test" ones.
- **Local CLI state:** the contents of `~/.dropbox-cli/` or `$DROPBOX_CLI_CONFIG_DIR` (`config.json`, `auth.json`).
- **Environment files:** `.env` and `.env.*` files (Bun loads these automatically, so they often hold real values).
- **Personal data:** real email addresses, names, Dropbox account IDs, shared links, or real file/folder paths from anyone's Dropbox or machine (e.g. `/Users/<name>/...`).
- **Internal information:** hostnames, internal URLs, company or customer names, or anything copied from private repos, tickets, or chats.
- **Debug artifacts:** logs, HTTP request/response dumps, or command output that may contain tokens or personal data.

### Use placeholders

- Test fixtures and docs use clearly fake values: `user@example.com`, `test-client-id`, `fake-access-token`, `/Documents/example.txt`.
- Never paste real API responses into tests or docs without scrubbing every identifier first.
- Agent-generated plans and specs (e.g. `docs/superpowers/`) get the same scrutiny as code. Strip local paths, usernames, and machine details before committing them.

### Never log secrets

`--verbose` output (`log()` in `src/lib/logger.ts`) is something users paste into bug reports. Never log tokens, `Authorization` headers, app secrets, authorization codes, or full request/response bodies from auth endpoints.

### Before every commit and push

1. Review exactly what's going in: run `git status` and `git diff --staged`. Stage specific files and avoid `git add -A` / `git add .` unless you've reviewed every file.
2. Scan the staged diff for secrets and personal data:
   ```sh
   git diff --staged | rg -i 'secret|token|password|api[_-]?key|client_id|bearer|BEGIN .*PRIVATE KEY|/Users/|/home/'
   ```
3. Check that no ignored or sensitive files were force-added (`.env*`, `config.json`, `auth.json`, `*.log`).
4. Keep commit messages and PR descriptions free of the items above.

### If a secret is committed

Stop and tell the user right away. **Don't push.** If it has already been pushed, rotating or revoking the credential comes first (removing it from history does not undo the exposure), and any history rewrite needs the user's explicit approval.

## Tooling

Default to Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun install` instead of `npm install`
- Use `bun run <script>` instead of `npm run <script>`
- Bun automatically loads `.env`, so don't use dotenv.

| Task       | Command                |
| ---------- | ---------------------- |
| Run CLI    | `bun run dev -- <args>` |
| Test       | `bun test`             |
| Type-check | `bun run typecheck`    |
| Build      | `bun run build`        |

CI (`.github/workflows/ci.yml`) runs `bun run typecheck` and `bun test` on every PR and push to `master`. Run both before pushing.

## CLI Output Contract

People pipe this CLI's output into scripts, so stdout must stay machine-readable.

- **stdout carries only the JSON envelope:** `{ "ok": true, "data": ... }` via `printSuccess`, or `{ "ok": false, "error": { "code", "message" } }` via `printError` (both in `src/lib/output.ts`). Never `console.log` anything else.
- **Everything else goes to stderr** through `src/lib/logger.ts`:
  - `logHuman()` for progress and messages shown with `--human`
  - `log()` for debug output shown with `--verbose`
  - `logError()` for messages that should always appear
- **Exit codes:** `0` success, `1` general error, `2` auth error (`printAuthError`).

## Code Structure

- Each command lives in `src/commands/<name>.ts` and exports `register<Name>Command(program)`.
- Register commands and their imports in **alphabetical order** in `src/index.ts`.
- Every command includes usage examples via `.addHelpText("after", ...)`.
- All Dropbox API calls go through `src/lib/api.ts` (`rpc`, `rpcRaw`, `contentUpload`, `contentDownload`, `pollBatchJob`). It handles auth, token refresh, retries, rate limiting, and error output. Don't call `fetch` against Dropbox directly from commands.
- Shared types live in `src/types.ts`.

## Testing

Use `bun test` (`import { describe, test, expect, mock } from "bun:test"`).

- `tests/` mirrors `src/`: `src/commands/ls.ts` → `tests/commands/ls.test.ts`.
- Tests never call the real Dropbox API. Command tests mock `../../src/lib/api` and `../../src/lib/output` with `mock.module`; follow an existing test such as `tests/commands/mkdir.test.ts`.
- Tests that touch config set `DROPBOX_CLI_CONFIG_DIR` to a throwaway directory and delete it afterwards, so they never read or write the real `~/.dropbox-cli/`.
- Fixtures use fake data only (see the security section above).

## Documentation

Keep these in sync with any user-facing change. A new command or flag means updating all of them:

- `README.md` command reference
- The command's `addHelpText` examples
- `CHANGELOG.md`: add entries under `## Unreleased`, grouped by Added, Fixed, Changed, Removed, Refactored

## Commits

Use conventional commits, matching the existing history: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `ci:`, with an optional scope such as `fix(bulk-mv): ...`.

## Releases

Never bump versions, create tags, or push tags without the user's explicit request. Pushing a `v*` tag triggers `.github/workflows/release.yml`, which publishes binaries for every platform in a public GitHub release.

When asked to release:

1. Bump the version in **both** `package.json` and `src/index.ts` (`.version(...)`).
2. Move `## Unreleased` entries in `CHANGELOG.md` under a new `## [x.y.z] - YYYY-MM-DD` heading.
3. The release notes are the **entire** `CHANGELOG.md` file, so review it as public text before tagging.
