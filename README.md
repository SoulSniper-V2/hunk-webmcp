# Hunk

**Same diff. You submit.**

A human and an agent review a real public GitHub pull request on the same diff. The agent drafts line comments. Only the human can submit.

Data is GitHub’s — not invented people, not a fake codebase. The default demo is [openai/codex#31922](https://github.com/openai/codex/pull/31922) (*core: add tool-free thread mode*).

Live: https://hunk-webmcp.vercel.app

## Why WebMCP

Codex’s job is generating PRs. The bottleneck is review. Official WebMCP showcases are cards, meals, and canvases. Hunk is the thing reviewers already do: read a unified diff, leave a line comment, pick a verdict.

Hunk registers **imperative** tools on `document.modelContext` / `navigator.modelContext` after mount, with an `AbortSignal`. No iframe tools. No declarative HTML tools. Feature-detect only.

The agent can import a PR, walk files and hunks, and draft comments. It cannot submit. Submit is a human button. After submit, mutating tools refuse.

## How to test in ChatGPT desktop

Use **Sol** or **Terra**, not Luna. Open the live URL in the in-app browser.

Or Chrome 149+ with `chrome://flags/#enable-webmcp-testing`, then a **full restart**.

You should see **Agent connected · 8 tools**. If not, the offline banner explains the same path. The UI works without WebMCP.

1. Confirm the default PR is `openai/codex#31922` (live via `/api/pr`, or the baked `public/demo-pr.json` snapshot if GitHub rate-limits).
2. `list_files` — real Rust paths (`turn.rs`, `session.rs`, `mcp.rs`, `features/src/lib.rs`, schema).
3. `get_hunks` / `goto_hunk` on `codex-rs/core/src/session/turn.rs`.
4. `add_comment` — tagged **Agent**, status **Draft**. Does **not** submit.
5. `set_verdict` — still a draft.
6. **You** click **Submit review**. The app seals an immutable receipt, copies a GitHub-flavored review body, and links the PR.

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
- After seal, `add_comment` and `set_verdict` refuse.

Do not expect a post on `openai/codex` without a token that can review that repository.

## Keyboard

`j` / `k` files · `n` next hunk · `/` search files · click a line to comment

## Run

```bash
npm install
npm run dev
```

```bash
npm run build
npm run preview
npm run prove
```

Required headers (Vite dev/preview, Vercel, `public/_headers`):

- `Origin-Agent-Cluster: ?1`
- `Permissions-Policy: tools=(self)`

Never ship `Origin-Agent-Cluster: ?0`.

`GET /api/pr?owner=&repo=&number=` (or `?url=`) fetches GitHub server-side. Optional `Authorization` only if `process.env.GITHUB_TOKEN` exists. The app works unauthenticated.

## Stack

Vite · React · TypeScript · Vercel serverless `/api`. MIT.
