import { DEFAULT_PR } from "./types";
import type {
  Actor,
  CommentSide,
  DraftComment,
  PrSource,
  PullRequest,
  Receipt,
  Verdict,
} from "./types";
import { commentable, parsePatch } from "./diff";

export interface AppState {
  pr: PullRequest | null;
  source: PrSource | null;
  loading: boolean;
  submitting: boolean;
  error: string | null;
  selectedPath: string | null;
  focusHunk: { path: string; startLine: number } | null;
  comments: DraftComment[];
  verdict: Verdict;
  sealed: Receipt | null;
  fileQuery: string;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let importVersion = 0;

let state: AppState = {
  pr: null,
  source: null,
  loading: false,
  submitting: false,
  error: null,
  selectedPath: null,
  focusHunk: null,
  comments: [],
  verdict: "comment",
  sealed: null,
  fileQuery: "",
};

function emit() {
  for (const fn of listeners) fn();
}

function set(partial: Partial<AppState>) {
  state = { ...state, ...partial };
  emit();
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSnapshot(): AppState {
  return state;
}

export function getState(): AppState {
  return state;
}

function nid(): string {
  return `hk_${Math.random().toString(36).slice(2, 10)}`;
}

function requirePr(): PullRequest {
  if (!state.pr) throw new Error("No pull request loaded. Call import_pr first.");
  return state.pr;
}

function assertDraft(action: string) {
  if (state.submitting) throw new Error(`Review is being submitted. ${action} is refused.`);
  if (state.loading) throw new Error(`Pull request is loading. ${action} is refused.`);
  if (state.sealed) {
    throw new Error(`Review is sealed. ${action} is refused.`);
  }
}

function isDefaultRef(owner: string, repo: string, number: number): boolean {
  return (
    owner.toLowerCase() === DEFAULT_PR.owner &&
    repo.toLowerCase() === DEFAULT_PR.repo &&
    number === DEFAULT_PR.number
  );
}

export function parsePrInput(input: {
  url?: string;
  owner?: string;
  repo?: string;
  number?: number | string;
}): { owner: string; repo: string; number: number } {
  const url = (input.url ?? "").trim();
  if (url) {
    const m =
      url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i) ||
      url.match(/^([^/\s]+)\/([^/\s]+)#(\d+)$/) ||
      url.match(/^([^/\s]+)\/([^/\s]+)\/(\d+)$/) ||
      url.match(/^([^/\s]+)\/([^/\s]+)\/pull\/(\d+)$/i);
    if (!m) throw new Error("Could not parse a GitHub pull request URL");
    return { owner: m[1], repo: m[2], number: Number(m[3]) };
  }
  const owner = String(input.owner ?? "").trim();
  const repo = String(input.repo ?? "").trim();
  const number = Number(input.number);
  if (!owner || !repo || !Number.isFinite(number) || number <= 0) {
    throw new Error("Provide a GitHub PR url or owner, repo, and number");
  }
  return { owner, repo, number };
}

function coercePr(raw: unknown): PullRequest {
  if (!raw || typeof raw !== "object") throw new Error("Invalid pull request payload");
  const p = raw as Record<string, unknown>;
  const filesIn = Array.isArray(p.files) ? p.files : [];
  const files = filesIn.map((f) => {
    const file = f as Record<string, unknown>;
    return {
      filename: String(file.filename ?? ""),
      status: String(file.status ?? "modified"),
      additions: Number(file.additions ?? 0),
      deletions: Number(file.deletions ?? 0),
      patch: typeof file.patch === "string" ? file.patch : "",
    };
  }).filter((f) => f.filename);
  if (!p.owner || !p.repo || !p.number) throw new Error("Pull request payload is missing owner/repo/number");
  return {
    owner: String(p.owner),
    repo: String(p.repo),
    number: Number(p.number),
    title: String(p.title ?? ""),
    html_url: String(p.html_url ?? `https://github.com/${p.owner}/${p.repo}/pull/${p.number}`),
    user: String(p.user ?? ""),
    state: String(p.state ?? "open"),
    draft: Boolean(p.draft),
    head: String(p.head ?? ""),
    base: String(p.base ?? ""),
    additions: typeof p.additions === "number" ? p.additions : undefined,
    deletions: typeof p.deletions === "number" ? p.deletions : undefined,
    changed_files: typeof p.changed_files === "number" ? p.changed_files : files.length,
    files,
  };
}

export function loadPrPayload(raw: unknown, source: PrSource = "snapshot"): PullRequest {
  if (state.submitting) throw new Error("Wait for review submission before loading another pull request.");
  const pr = coercePr(raw);
  importVersion += 1;
  set({
    pr,
    source,
    loading: false,
    error: null,
    selectedPath: pr.files[0]?.filename ?? null,
    focusHunk: null,
    comments: [],
    verdict: "comment",
    sealed: null,
    fileQuery: "",
  });
  return pr;
}

async function fetchSnapshot(): Promise<unknown> {
  if (typeof fetch !== "function") {
    throw new Error("No snapshot available in this environment");
  }
  const res = await fetch("/demo-pr.json");
  if (!res.ok) throw new Error("Snapshot fallback failed");
  return res.json();
}

export async function importPr(input: {
  url?: string;
  owner?: string;
  repo?: string;
  number?: number | string;
}): Promise<PullRequest> {
  if (state.submitting) throw new Error("Wait for review submission before loading another pull request.");
  let ref: ReturnType<typeof parsePrInput>;
  try {
    ref = parsePrInput(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    set({ error: message });
    throw err instanceof Error ? err : new Error(message);
  }
  const version = ++importVersion;
  const ensureCurrent = () => {
    if (version !== importVersion) throw new Error("Pull request import was superseded by a newer load.");
  };
  set({ loading: true, error: null });
  const qs = new URLSearchParams({
    owner: ref.owner,
    repo: ref.repo,
    number: String(ref.number),
  });
  try {
    let data: unknown;
    let source: PrSource = "live";
    try {
      const res = await fetch(`/api/pr?${qs.toString()}`);
      ensureCurrent();
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Failed to load ${ref.owner}/${ref.repo}#${ref.number}`);
      }
      data = coercePr(await res.json());
    } catch (err) {
      ensureCurrent();
      if (!isDefaultRef(ref.owner, ref.repo, ref.number)) throw err;
      data = await fetchSnapshot();
      source = "snapshot";
    }
    ensureCurrent();
    return loadPrPayload(data, source);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (version === importVersion) set({ loading: false, error: message });
    throw err instanceof Error ? err : new Error(message);
  }
}

export async function loadDefaultPr(): Promise<PullRequest> {
  return importPr({
    owner: DEFAULT_PR.owner,
    repo: DEFAULT_PR.repo,
    number: DEFAULT_PR.number,
  });
}

export function listFiles() {
  const pr = requirePr();
  const q = state.fileQuery.trim().toLowerCase();
  const files = pr.files
    .filter((f) => !q || f.filename.toLowerCase().includes(q))
    .map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      hunks: parsePatch(f.patch).length,
    }));
  return {
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    html_url: pr.html_url,
    selected: state.selectedPath,
    files,
  };
}

export function openFile(path: string) {
  const pr = requirePr();
  const file = pr.files.find((f) => f.filename === path);
  if (!file) throw new Error(`Unknown file: ${path}`);
  set({ selectedPath: path, focusHunk: null });
  return {
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    hunks: parsePatch(file.patch).length,
  };
}

export function getHunks(path: string) {
  const pr = requirePr();
  const file = pr.files.find((f) => f.filename === path);
  if (!file) throw new Error(`Unknown file: ${path}`);
  const hunks = parsePatch(file.patch);
  return {
    filename: file.filename,
    hunks: hunks.map((h) => ({
      header: h.header,
      start_line: h.startLine,
      old_start: h.oldStart,
      new_start: h.newStart,
      lines: h.lines.length,
    })),
  };
}

export function gotoHunk(path: string, startLine: number) {
  const pr = requirePr();
  const file = pr.files.find((f) => f.filename === path);
  if (!file) throw new Error(`Unknown file: ${path}`);
  const hunks = parsePatch(file.patch);
  const hunk = hunks.find((h) => h.startLine === startLine) ?? hunks.find((h) => h.newStart === startLine);
  if (!hunk) throw new Error(`No hunk at line ${startLine} in ${path}`);
  set({ selectedPath: path, focusHunk: { path, startLine: hunk.startLine } });
  return { filename: path, header: hunk.header, start_line: hunk.startLine };
}

export function addComment(input: {
  path: string;
  line: number;
  body: string;
  side?: CommentSide;
  actor?: Actor;
}): DraftComment {
  assertDraft("add_comment");
  const pr = requirePr();
  const path = input.path;
  const file = pr.files.find((f) => f.filename === path);
  if (!file) throw new Error(`Unknown file: ${path}`);
  const body = input.body.trim();
  if (!body) throw new Error("Comment body is required");
  const line = Number(input.line);
  if (!Number.isSafeInteger(line) || line <= 0) throw new Error("line must be a positive integer");
  const side = input.side ?? "RIGHT";
  if (side !== "LEFT" && side !== "RIGHT") throw new Error("side must be LEFT or RIGHT");
  const exists = parsePatch(file.patch).some((hunk) => hunk.lines.some((row) => {
    const target = commentable(row);
    return target?.line === line && target.side === side;
  }));
  if (!exists) throw new Error(`No commentable ${side} line ${line} in ${path}`);
  const comment: DraftComment = {
    id: nid(),
    path,
    line,
    body,
    side,
    actor: input.actor ?? "human",
  };
  set({
    comments: [...state.comments, comment],
    selectedPath: path,
  });
  return comment;
}

export function listComments() {
  return {
    sealed: Boolean(state.sealed),
    verdict: state.verdict,
    comments: state.comments.map((c) => ({ ...c })),
  };
}

export function setVerdict(verdict: Verdict): { verdict: Verdict; sealed: false } {
  assertDraft("set_verdict");
  requirePr();
  if (verdict !== "comment" && verdict !== "request_changes" && verdict !== "approve") {
    throw new Error("verdict must be comment, request_changes, or approve");
  }
  set({ verdict });
  return { verdict, sealed: false };
}

export function setFileQuery(query: string) {
  set({ fileQuery: query });
}

export function submitDisabledReason(): string | null {
  if (state.submitting) return "Review is being submitted";
  if (state.loading) return "Wait for the pull request to finish loading";
  if (state.sealed) return "Review already sealed";
  if (!state.pr) return "Load a pull request first";
  if (state.comments.length === 0 && state.verdict === "comment") {
    return "Add a comment or choose approve / request changes";
  }
  return null;
}

export function formatReviewBody(pr: PullRequest, verdict: Verdict, comments: DraftComment[]): string {
  const label =
    verdict === "approve" ? "Approve" : verdict === "request_changes" ? "Request changes" : "Comment";
  const lines = [
    `## Review (Hunk)`,
    ``,
    `**Verdict:** ${label}`,
    ``,
  ];
  if (!comments.length) {
    lines.push(`_No line comments._`);
  } else {
    for (const c of comments) {
      const who = c.actor === "agent" ? "agent" : "you";
      lines.push(`### \`${c.path}\` (L${c.line}, ${c.side})`);
      lines.push(``);
      lines.push(c.body);
      lines.push(``);
      lines.push(`— ${who}`);
      lines.push(``);
    }
  }
  lines.push(`---`);
  lines.push(`Drafted in [Hunk](${pr.html_url}). Same diff. You submit.`);
  return lines.join("\n");
}

function githubEvent(verdict: Verdict): "COMMENT" | "REQUEST_CHANGES" | "APPROVE" {
  if (verdict === "approve") return "APPROVE";
  if (verdict === "request_changes") return "REQUEST_CHANGES";
  return "COMMENT";
}

export async function submitReview(): Promise<Receipt> {
  if (state.sealed) throw new Error("Review already sealed");
  const pr = requirePr();
  const reason = submitDisabledReason();
  if (reason) throw new Error(reason);
  const comments = state.comments.map((c) => ({ ...c }));
  const verdict = state.verdict;
  const body = formatReviewBody(pr, verdict, comments);
  // Lock the shared human/agent draft before the first asynchronous operation.
  set({ submitting: true });

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(body);
    } catch {
      /* clipboard may be blocked in headless */
    }
  }

  let githubPosted = false;
  let githubMessage = "Sealed here. Open on GitHub to post.";

  try {
    const res = await fetch("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owner: pr.owner,
        repo: pr.repo,
        number: pr.number,
        event: githubEvent(verdict),
        body,
        comments: comments.map((c) => ({
          path: c.path,
          line: c.line,
          body: c.body,
          side: c.side,
        })),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      posted?: boolean;
      message?: string;
      reason?: string;
    };
    if (res.ok && data.posted === true) {
      githubPosted = true;
      githubMessage = "Posted to GitHub.";
    } else {
      githubPosted = false;
      githubMessage = data.message || "Sealed here. Open on GitHub to post.";
    }
  } catch {
    githubPosted = false;
    githubMessage = "Sealed here. Open on GitHub to post.";
  }

  const receipt: Receipt = {
    timestamp: new Date().toISOString(),
    verdict,
    comments,
    prUrl: pr.html_url,
    githubPosted,
    githubMessage,
    body,
  };
  set({ sealed: receipt, submitting: false });
  return receipt;
}
