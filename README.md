# Hunk

**Same diff. You submit.**

A human and an agent review a real public GitHub pull request on the same diff. The agent drafts line comments. Only the human can submit.

Data is GitHub’s — not invented people, not a fake codebase. The default demo is [openai/codex#31922](https://github.com/openai/codex/pull/31922) (*core: add tool-free thread mode*).

Live: https://hunk-webmcp.vercel.app

## Why WebMCP

Codex’s job is generating PRs. The bottleneck is review. Official WebMCP showcases are cards, meals, and canvases. Hunk is the thing reviewers already do: read a unified diff, leave a line comment, pick a verdict.

Hunk registers **imperative** tools on `document.modelContext` / `navigator.modelContext` after mount, with an `AbortSignal`. No iframe tools. No declarative HTML tools. Feature-detect only.

The agent can import a PR, walk files and hunks, and draft comments. It cannot submit. Submit is a human button. After submit, draft edits refuse until a new PR is loaded.

## How to test WebMCP

Use a browser with WebMCP enabled. For Chrome's current testing and availability requirements, follow the [official WebMCP guide](https://developer.chrome.com/docs/ai/webmcp). Enable `chrome://flags/#enable-webmcp-testing` where available, then restart the browser.

After all registrations succeed, you should see **Agent connected · 8 tools**. This indicates registered browser tools, not an active external agent session. Failed registrations leave the offline banner visible. The UI works without WebMCP.

Registration follows the [asynchronous WebMCP API](https://developer.chrome.com/docs/ai/webmcp/imperative-api) and aborts on unmount.

1. Confirm the default PR is `openai/codex#31922` (live via `/api/pr`, or the baked `public/demo-pr.json` snapshot if GitHub rate-limits).
2. `list_files` — real Rust paths (`turn.rs`, `session.rs`, `mcp.rs`, `features/src/lib.rs`, schema).
3. `get_hunks` / `goto_hunk` on `codex-rs/core/src/session/turn.rs`.
4. `add_comment` — tagged **Agent**, status **Draft**. Does **not** submit.
5. `set_verdict` — still a draft.
6. **You** click **Submit review**. The app seals a receipt, attempts to copy a GitHub-flavored review body, and links the PR.

There is no `submit_review` tool. There is no merge tool.

## Tools

| Tool | Access | What it does |
|---|---|---|
| `import_pr` | write | Load a public PR by URL or `owner` / `repo` / `number`. |
| `list_files` | read | Files with `+n` / `−n`. |
| `open_file` | write | Select a file in the viewer. |
| `get_hunks` | read | Parsed `@@` hunks for a path. |
| `goto_hunk` | write | Jump to `path` + `start_line`. |
| `add_comment` | write | Draft a line comment as the agent. Does not submit. |
| `list_comments` | read | Draft comments + verdict. |
| `set_verdict` | write | `comment` \| `request_changes` \| `approve`. Still draft. |

Human UI calls the **same store functions** as the tools.

## Submit is human-only

- Agent comments are **draft** until submit.
- Submit seals a receipt: timestamp, verdict, comments, PR URL.
- Copies a GitHub-flavored review body and links the PR.
- If `GITHUB_TOKEN` is set **and** that token can review the repo, the server POSTs a real pull request review.
- If not, Hunk does **not** fake a GitHub 200. You see: **Sealed here. Open on GitHub to post.** plus the exact body.
- During submission, the draft and PR are locked so a second click or agent action cannot change the submitted verdict or comments.
- After seal, `add_comment` and `set_verdict` refuse. Loading another PR starts a new review.
- Line comments must target an existing displayed line on the chosen side of the diff.

Do not expect a post on `openai/codex` without a token that can review that repository.

The API has no user authentication. Leave `GITHUB_TOKEN` unset on a public deployment: a configured token can expose repositories it can read and lets callers post reviews with its permissions. Token-backed posting is for a trusted local environment. The human-only submit rule describes the WebMCP tool surface and UI, not server authorization.

## Keyboard

`j` / `k` files · `n` next hunk · `/` search files · click a line to comment

## Run

Use Node.js 24 LTS (see `.nvmrc`) and npm. Install the committed dependency versions:

```bash
npm ci --ignore-scripts
npm run dev
```

Dev and preview bind to localhost by default. The Vite plugin serves `/api/pr` and `/api/review` locally; Vercel uses the handlers in `api/`. A static-only host has no live GitHub API: only the bundled demo snapshot and local review receipt work.

```bash
npm run build
npm run preview
npm run prove
npm test
npm run check:server
```

`prove` checks the eight tools against the real store using a mocked WebMCP browser API. `test` covers submission/import races, comment targets, and asynchronous registration without making GitHub writes. `check:server` starts and closes dev and built-preview servers on temporary ports, verifies their HTTP entry points and required headers, and checks token-free API behavior. Run `build` before `check:server`. These checks do not replace testing native WebMCP in a supported browser.

GitHub Actions runs the build and these checks on Node 22, 24, and 26. The lockfile makes local and CI installs reproducible.

Required headers (Vite dev/preview, Vercel, `public/_headers`):

- `Origin-Agent-Cluster: ?1`
- `Permissions-Policy: tools=(self)`

Never ship `Origin-Agent-Cluster: ?0`.

`GET /api/pr?owner=&repo=&number=` (or `?url=`) fetches GitHub server-side. Optional `Authorization` only if `process.env.GITHUB_TOKEN` exists. The app works unauthenticated. Imports currently inspect only the first 20 changed files and omit recognized binary files and patches above 200 KB; the view is not a complete large-PR review.

## Stack

Vite · React · TypeScript · Vercel serverless `/api`. MIT.
