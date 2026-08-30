import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { commentable, parsePatch } from "./diff";
import {
  addComment,
  getSnapshot,
  gotoHunk,
  importPr,
  loadDefaultPr,
  openFile,
  setFileQuery,
  setVerdict,
  submitDisabledReason,
  submitReview,
  subscribe,
} from "./store";
import { DEFAULT_PR, VERDICTS } from "./types";
import type { CommentSide, DraftComment, Hunk, HunkLine, Verdict } from "./types";
import { getModelContext, registerTools, TOOL_NAMES } from "./webmcp";

const VERDICT_LABEL: Record<Verdict, string> = {
  comment: "Comment",
  request_changes: "Request changes",
  approve: "Approve",
};

export function App() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [banner, setBanner] = useState(true);
  const [tools, setTools] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [url, setUrl] = useState<string>(DEFAULT_PR.url);
  const [composer, setComposer] = useState<{
    path: string;
    line: number;
    side: CommentSide;
  } | null>(null);
  const [draftBody, setDraftBody] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  const pr = state.pr;
  const files = useMemo(() => {
    if (!pr) return [];
    const q = state.fileQuery.trim().toLowerCase();
    return pr.files.filter((f) => !q || f.filename.toLowerCase().includes(q));
  }, [pr, state.fileQuery]);

  const selected = pr?.files.find((f) => f.filename === state.selectedPath) ?? pr?.files[0] ?? null;
  const hunks = useMemo(() => (selected ? parsePatch(selected.patch) : []), [selected]);

  useEffect(() => {
    const ac = new AbortController();
    const names = registerTools(ac.signal);
    setTools(names);
    setConnected(names.length > 0 || !!getModelContext());
    return () => ac.abort();
  }, []);

  useEffect(() => {
    void loadDefaultPr().catch(() => {
      /* store records the error */
    });
  }, []);

  useEffect(() => {
    if (!state.focusHunk) return;
    const el = document.querySelector(`[data-hunk="${state.focusHunk.path}:${state.focusHunk.startLine}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [state.focusHunk]);

  const loadFromUrl = useCallback(async () => {
    setSubmitError(null);
    try {
      await importPr({ url: url.trim() || DEFAULT_PR.url });
    } catch {
      /* store.error */
    }
  }, [url]);

  const moveFile = useCallback(
    (dir: 1 | -1) => {
      if (!files.length) return;
      const idx = Math.max(0, files.findIndex((f) => f.filename === selected?.filename));
      const next = files[(idx + dir + files.length) % files.length];
      openFile(next.filename);
    },
    [files, selected],
  );

  const nextHunk = useCallback(() => {
    if (!pr) return;
    const all: Array<{ path: string; start: number }> = [];
    for (const f of files) {
      for (const h of parsePatch(f.patch)) all.push({ path: f.filename, start: h.startLine });
    }
    if (!all.length) return;
    const curPath = selected?.filename;
    const curStart = state.focusHunk?.startLine;
    let idx = all.findIndex((h) => h.path === curPath && h.start === curStart);
    if (idx < 0) idx = all.findIndex((h) => h.path === curPath);
    const next = all[(idx + 1) % all.length];
    gotoHunk(next.path, next.start);
  }, [pr, files, selected, state.focusHunk]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (e.key === "Escape") {
        setComposer(null);
        (e.target as HTMLElement)?.blur?.();
        return;
      }
      if (typing) return;
      if (e.key === "j") moveFile(1);
      if (e.key === "k") moveFile(-1);
      if (e.key === "n") nextHunk();
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moveFile, nextHunk]);

  const disabled = submitDisabledReason();

  const onSubmit = useCallback(async () => {
    setSubmitError(null);
    setCopied(false);
    try {
      await submitReview();
      setCopied(true);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const commentsByLine = useMemo(() => {
    const map = new Map<string, DraftComment[]>();
    for (const c of state.comments) {
      const key = `${c.path}:${c.side}:${c.line}`;
      const arr = map.get(key) ?? [];
      arr.push(c);
      map.set(key, arr);
    }
    return map;
  }, [state.comments]);

  return (
    <div className="app">
      {banner && !connected && (
        <div className="banner">
          <span>
            Agent offline. Open this page in ChatGPT desktop’s in-app browser (Sol/Terra, not Luna) or Chrome 149+
            with <code>chrome://flags/#enable-webmcp-testing</code>, then fully restart the browser.
          </span>
          <button type="button" className="dismiss" onClick={() => setBanner(false)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <header className="top">
        <div className="brand">
          <a className="wordmark" href="/" aria-label="Hunk">
            Hunk
          </a>
          <span className="tag">Same diff. You submit.</span>
        </div>

        <div className="pr-meta">
          {pr ? (
            <>
              <a className="pr-title" href={pr.html_url} target="_blank" rel="noreferrer">
                {pr.title} <span className="pr-num">#{pr.number}</span>
              </a>
              <span className="pr-repo">
                {pr.owner}/{pr.repo}
                {pr.draft ? <em className="pill draft">Draft</em> : null}
                <em className={`pill ${pr.state}`}>{pr.state}</em>
                {state.source === "snapshot" ? <em className="pill snap">Snapshot</em> : null}
                {state.source === "live" ? <em className="pill live">Live</em> : null}
              </span>
            </>
          ) : (
            <span className="pr-title muted">
              {state.loading ? "Loading pull request…" : "No pull request loaded"}
            </span>
          )}
        </div>

        <form
          className="load"
          onSubmit={(e) => {
            e.preventDefault();
            void loadFromUrl();
          }}
        >
          <input
            ref={urlRef}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="github.com/owner/repo/pull/123"
            aria-label="Pull request URL"
          />
          <button type="submit" disabled={state.loading}>
            {state.loading ? "Loading" : "Load"}
          </button>
        </form>

        <div className={`agent ${connected ? "on" : "off"}`}>
          <span className="dot" />
          {connected ? `Agent connected · ${tools.length || TOOL_NAMES.length} tools` : "Agent offline"}
        </div>
      </header>

      {!pr && !state.loading ? (
        <Empty error={state.error} url={url} setUrl={setUrl} onLoad={() => void loadFromUrl()} />
      ) : (
        <div className="workspace">
          <aside className="files">
            <div className="files-head">
              <span>Files</span>
              <span className="count">{pr ? `${files.length}/${pr.files.length}` : "—"}</span>
            </div>
            <input
              ref={searchRef}
              className="file-search"
              value={state.fileQuery}
              onChange={(e) => setFileQuery(e.target.value)}
              placeholder="Search files  /"
              aria-label="Search files"
            />
            <ul>
              {files.map((f) => (
                <li key={f.filename}>
                  <button
                    type="button"
                    className={f.filename === selected?.filename ? "active" : ""}
                    onClick={() => openFile(f.filename)}
                  >
                    <span className="fname">
                      <span className="dir">{dirname(f.filename)}</span>
                      <span className="base">{basename(f.filename)}</span>
                    </span>
                    <span className="stat">
                      <em className="add">+{f.additions}</em>
                      <em className="del">−{f.deletions}</em>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="hint">j / k files · n hunk · / search</p>
          </aside>

          <main className="diff">
            {selected ? (
              <>
                <div className="diff-head">
                  <code>{selected.filename}</code>
                  <span className="stat">
                    <em className="add">+{selected.additions}</em>
                    <em className="del">−{selected.deletions}</em>
                    <em className="status">{selected.status}</em>
                  </span>
                </div>
                <div className="diff-body">
                  {hunks.length === 0 ? (
                    <p className="empty-diff">No textual patch for this file.</p>
                  ) : (
                    hunks.map((h) => (
                      <HunkView
                        key={h.header}
                        hunk={h}
                        path={selected.filename}
                        commentsByLine={commentsByLine}
                        composer={composer}
                        draftBody={draftBody}
                        setDraftBody={setDraftBody}
                        setComposer={setComposer}
                        sealed={Boolean(state.sealed)}
                        focused={
                          state.focusHunk?.path === selected.filename &&
                          state.focusHunk.startLine === h.startLine
                        }
                      />
                    ))
                  )}
                </div>
              </>
            ) : (
              <p className="empty-diff">{state.loading ? "Fetching the pull request…" : "Select a file."}</p>
            )}
          </main>

          <aside className="review">
            <div className="review-head">
              <span>Review</span>
              {state.sealed ? <em className="pill snap">Sealed</em> : <em className="pill draft">Draft</em>}
            </div>

            <div className="comments">
              {state.comments.length === 0 ? (
                <p className="quiet">
                  No line comments yet. Click a diff line, or let the agent call <code>add_comment</code>.
                  Comments stay draft until you submit.
                </p>
              ) : (
                state.comments.map((c) => (
                  <article key={c.id} className="note">
                    <header>
                      <button type="button" onClick={() => openFile(c.path)}>
                        {basename(c.path)}
                        <span className="ln">
                          :{c.line} {c.side === "LEFT" ? "L" : "R"}
                        </span>
                      </button>
                      <span className={`who ${c.actor}`}>{c.actor === "agent" ? "Agent" : "You"}</span>
                    </header>
                    <p>{c.body}</p>
                  </article>
                ))
              )}
            </div>

            <fieldset className="verdicts" disabled={Boolean(state.sealed)}>
              <legend>Verdict</legend>
              {VERDICTS.map((v) => (
                <label key={v}>
                  <input
                    type="radio"
                    name="verdict"
                    checked={state.verdict === v}
                    onChange={() => setVerdict(v)}
                  />
                  {VERDICT_LABEL[v]}
                </label>
              ))}
            </fieldset>

            <button
              type="button"
              className="submit"
              disabled={Boolean(disabled) || Boolean(state.sealed)}
              title={disabled ?? "Seal this review. Only you can submit."}
              onClick={() => void onSubmit()}
            >
              Submit review
            </button>
            {disabled && !state.sealed ? <p className="why">{disabled}</p> : null}
            {submitError ? <p className="why err">{submitError}</p> : null}
            <p className="quiet lock">
              Submit is human-only. It is not a WebMCP tool. The agent can draft; it cannot post.
            </p>

            {state.sealed ? (
              <ReceiptCard
                receipt={state.sealed}
                copied={copied}
                onCopy={async () => {
                  try {
                    await navigator.clipboard.writeText(state.sealed!.body);
                    setCopied(true);
                  } catch {
                    setCopied(false);
                  }
                }}
              />
            ) : null}
          </aside>
        </div>
      )}
    </div>
  );
}

function Empty({
  error,
  url,
  setUrl,
  onLoad,
}: {
  error: string | null;
  url: string;
  setUrl: (v: string) => void;
  onLoad: () => void;
}) {
  return (
    <div className="empty">
      <h1>Paste a public GitHub pull request.</h1>
      <p>
        Hunk loads the real diff — no invented sample code. The default is{" "}
        <a href={DEFAULT_PR.url} target="_blank" rel="noreferrer">
          openai/codex#{DEFAULT_PR.number}
        </a>
        , fetched live (with a baked snapshot if GitHub rate-limits).
      </p>
      {error ? <p className="why err">{error}</p> : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onLoad();
        }}
      >
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/owner/repo/pull/123"
          aria-label="Pull request URL"
        />
        <button type="submit">Load pull request</button>
      </form>
    </div>
  );
}

function ReceiptCard({
  receipt,
  copied,
  onCopy,
}: {
  receipt: {
    timestamp: string;
    verdict: Verdict;
    comments: DraftComment[];
    prUrl: string;
    githubPosted: boolean;
    githubMessage: string;
    body: string;
  };
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="receipt">
      <h3>Sealed</h3>
      <dl>
        <div>
          <dt>When</dt>
          <dd>{new Date(receipt.timestamp).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Verdict</dt>
          <dd>{VERDICT_LABEL[receipt.verdict]}</dd>
        </div>
        <div>
          <dt>Comments</dt>
          <dd>{receipt.comments.length}</dd>
        </div>
        <div>
          <dt>PR</dt>
          <dd>
            <a href={receipt.prUrl} target="_blank" rel="noreferrer">
              Open on GitHub
            </a>
          </dd>
        </div>
      </dl>
      <p className={receipt.githubPosted ? "posted" : "sealed-note"}>{receipt.githubMessage}</p>
      {!receipt.githubPosted ? (
        <pre className="body">{receipt.body}</pre>
      ) : null}
      <button type="button" className="copy" onClick={onCopy}>
        {copied ? "Copied review body" : "Copy review body"}
      </button>
    </div>
  );
}

function HunkView({
  hunk,
  path,
  commentsByLine,
  composer,
  draftBody,
  setDraftBody,
  setComposer,
  sealed,
  focused,
}: {
  hunk: Hunk;
  path: string;
  commentsByLine: Map<string, DraftComment[]>;
  composer: { path: string; line: number; side: CommentSide } | null;
  draftBody: string;
  setDraftBody: (v: string) => void;
  setComposer: (v: { path: string; line: number; side: CommentSide } | null) => void;
  sealed: boolean;
  focused: boolean;
}) {
  return (
    <section
      className={`hunk ${focused ? "focused" : ""}`}
      data-hunk={`${path}:${hunk.startLine}`}
    >
      <div className="hunk-head">{hunk.header}</div>
      <table>
        <tbody>
          {hunk.lines.map((line, i) => (
            <LineRow
              key={`${hunk.startLine}:${i}:${line.kind}:${line.oldNo}:${line.newNo}`}
              line={line}
              path={path}
              commentsByLine={commentsByLine}
              composer={composer}
              draftBody={draftBody}
              setDraftBody={setDraftBody}
              setComposer={setComposer}
              sealed={sealed}
            />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function LineRow({
  line,
  path,
  commentsByLine,
  composer,
  draftBody,
  setDraftBody,
  setComposer,
  sealed,
}: {
  line: HunkLine;
  path: string;
  commentsByLine: Map<string, DraftComment[]>;
  composer: { path: string; line: number; side: CommentSide } | null;
  draftBody: string;
  setDraftBody: (v: string) => void;
  setComposer: (v: { path: string; line: number; side: CommentSide } | null) => void;
  sealed: boolean;
}) {
  const target = commentable(line);
  const key = target ? `${path}:${target.side}:${target.line}` : "";
  const notes = key ? commentsByLine.get(key) ?? [] : [];
  const open =
    composer &&
    target &&
    composer.path === path &&
    composer.line === target.line &&
    composer.side === target.side;

  return (
    <>
      <tr
        className={`ln ${line.kind} ${target && !sealed ? "clickable" : ""}`}
        onClick={() => {
          if (!target || sealed) return;
          setComposer({ path, line: target.line, side: target.side });
          setDraftBody("");
        }}
      >
        <td className="no old">{line.oldNo ?? ""}</td>
        <td className="no new">{line.newNo ?? ""}</td>
        <td className="mark">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</td>
        <td className="code">
          <pre>{line.text || " "}</pre>
        </td>
      </tr>
      {notes.map((c) => (
        <tr key={c.id} className="inline-note">
          <td colSpan={4}>
            <div className={`bubble ${c.actor}`}>
              <span className={`who ${c.actor}`}>{c.actor === "agent" ? "Agent" : "You"}</span>
              <p>{c.body}</p>
            </div>
          </td>
        </tr>
      ))}
      {open ? (
        <tr className="composer">
          <td colSpan={4}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!composer) return;
                try {
                  addComment({
                    path: composer.path,
                    line: composer.line,
                    body: draftBody,
                    side: composer.side,
                    actor: "human",
                  });
                  setComposer(null);
                  setDraftBody("");
                } catch {
                  /* ignore empty */
                }
              }}
            >
              <textarea
                autoFocus
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                placeholder="Draft a comment on this line. Submit review is separate, and only you can do it."
                rows={3}
              />
              <div className="row">
                <button type="submit" disabled={!draftBody.trim()}>
                  Add draft
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    setComposer(null);
                    setDraftBody("");
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i + 1);
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}
