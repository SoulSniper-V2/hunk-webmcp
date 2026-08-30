export type Verdict = "comment" | "request_changes" | "approve";
export type CommentSide = "RIGHT" | "LEFT";
export type Actor = "human" | "agent";
export type PrSource = "live" | "snapshot";

export interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
}

export interface PullRequest {
  owner: string;
  repo: string;
  number: number;
  title: string;
  html_url: string;
  user: string;
  state: string;
  draft?: boolean;
  head: string;
  base: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  files: PrFile[];
}

export interface DraftComment {
  id: string;
  path: string;
  line: number;
  body: string;
  side: CommentSide;
  actor: Actor;
}

export interface Receipt {
  timestamp: string;
  verdict: Verdict;
  comments: DraftComment[];
  prUrl: string;
  githubPosted: boolean;
  githubMessage: string;
  body: string;
}

export interface HunkLine {
  kind: "ctx" | "add" | "del";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface Hunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  startLine: number;
  lines: HunkLine[];
}

export const DEFAULT_PR = {
  owner: "openai",
  repo: "codex",
  number: 31922,
  url: "https://github.com/openai/codex/pull/31922",
} as const;

export const VERDICTS: Verdict[] = ["comment", "request_changes", "approve"];
