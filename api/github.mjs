const USER_AGENT = "Hunk-WebMCP/1.0 (https://github.com/SoulSniper-V2/hunk-webmcp)";
const MAX_FILES = 20;
const MAX_PATCH = 200_000;
const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "svg",
  "pdf", "woff", "woff2", "ttf", "eot", "otf",
  "zip", "gz", "tgz", "bz2", "xz", "7z", "rar",
  "bin", "wasm", "exe", "dll", "so", "dylib",
  "mp4", "mp3", "wav", "mov", "webm", "ogg",
  "lockb", "pyc", "class",
]);

export function parsePrRef(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Provide a GitHub PR url or owner, repo, and number");
  }
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (url) {
    const hashed = url.match(/^([^/\s]+)\/([^/\s#]+)(?:#|\/pull\/|\/)(\d+)$/);
    if (hashed && !url.includes("://")) {
      return { owner: hashed[1], repo: hashed[2], number: Number(hashed[3]) };
    }
    const m = url.match(
      /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i,
    ) || url.match(/^([^/\s]+)\/([^/\s]+)\/(\d+)$/)
      || url.match(/^([^/\s]+)\/([^/\s]+)#(\d+)$/);
    if (!m) throw new Error("Could not parse a GitHub pull request URL");
    return { owner: m[1], repo: m[2], number: Number(m[3]) };
  }
  const owner = String(input.owner || "").trim();
  const repo = String(input.repo || "").trim();
  const number = Number(input.number);
  if (!owner || !repo || !Number.isFinite(number) || number <= 0) {
    throw new Error("Provide a GitHub PR url or owner, repo, and number");
  }
  return { owner, repo, number };
}

function ghHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function isBinaryName(filename) {
  const base = filename.split("/").pop() || filename;
  const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : "";
  if (BINARY_EXT.has(ext)) return true;
  if (/\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|eot|zip|gz|exe|dll|so|wasm)$/i.test(filename)) {
    return true;
  }
  return false;
}

export function normalizePr(meta, files) {
  const kept = [];
  for (const f of files.slice(0, MAX_FILES)) {
    if (isBinaryName(f.filename)) continue;
    const patch = typeof f.patch === "string" ? f.patch : "";
    if (patch.length > MAX_PATCH) continue;
    kept.push({
      filename: f.filename,
      status: f.status,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      patch,
    });
  }
  return {
    owner: meta.base?.repo?.owner?.login || meta.head?.repo?.owner?.login,
    repo: meta.base?.repo?.name || meta.head?.repo?.name,
    number: meta.number,
    title: meta.title,
    html_url: meta.html_url,
    user: meta.user?.login ?? "unknown",
    state: meta.state,
    draft: !!meta.draft,
    head: meta.head?.ref ?? "",
    base: meta.base?.ref ?? "",
    additions: meta.additions ?? kept.reduce((n, f) => n + f.additions, 0),
    deletions: meta.deletions ?? kept.reduce((n, f) => n + f.deletions, 0),
    changed_files: meta.changed_files ?? kept.length,
    files: kept,
  };
}

export async function fetchPullRequest({ owner, repo, number }) {
  const headers = ghHeaders();
  const [metaRes, filesRes] = await Promise.all([
    fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, { headers }),
    fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files?per_page=${MAX_FILES}`, { headers }),
  ]);

  if (metaRes.status === 403 || filesRes.status === 403) {
    const err = new Error("GitHub rate-limited this request");
    err.status = 403;
    err.code = "rate_limited";
    throw err;
  }
  if (metaRes.status === 404) {
    const err = new Error(`Pull request not found: ${owner}/${repo}#${number}`);
    err.status = 404;
    throw err;
  }
  if (!metaRes.ok) {
    const err = new Error(`GitHub pull request error ${metaRes.status}`);
    err.status = metaRes.status;
    throw err;
  }
  if (!filesRes.ok) {
    const err = new Error(`GitHub files error ${filesRes.status}`);
    err.status = filesRes.status;
    throw err;
  }

  const meta = await metaRes.json();
  const files = await filesRes.json();
  if (!Array.isArray(files)) {
    const err = new Error("GitHub did not return a file list");
    err.status = 502;
    throw err;
  }
  return normalizePr(meta, files);
}

export async function postPullRequestReview({ owner, repo, number, event, body, comments }) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { posted: false, reason: "no_token", message: "Sealed here. Open on GitHub to post." };
  }
  const payload = {
    event,
    body,
  };
  if (Array.isArray(comments) && comments.length) {
    payload.comments = comments.map((c) => ({
      path: c.path,
      body: c.body,
      line: c.line,
      side: c.side || "RIGHT",
    }));
  }
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/reviews`,
    {
      method: "POST",
      headers: {
        ...ghHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    return {
      posted: false,
      reason: res.status === 403 || res.status === 401 ? "forbidden" : "github_error",
      status: res.status,
      message: "Sealed here. Open on GitHub to post.",
      detail: json?.message || text.slice(0, 240),
    };
  }
  return {
    posted: true,
    reason: "posted",
    status: res.status,
    html_url: json?.html_url ?? null,
    id: json?.id ?? null,
  };
}
