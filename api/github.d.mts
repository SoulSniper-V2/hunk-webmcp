export function parsePrRef(input: {
  url?: string;
  owner?: string;
  repo?: string;
  number?: string | number;
}): { owner: string; repo: string; number: number };

export function normalizePr(meta: Record<string, unknown>, files: Array<Record<string, unknown>>): unknown;

export function fetchPullRequest(ref: {
  owner: string;
  repo: string;
  number: number;
}): Promise<unknown>;

export function postPullRequestReview(input: {
  owner: string;
  repo: string;
  number: number;
  event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
  body: string;
  comments?: Array<{ path: string; line: number; body: string; side?: string }>;
}): Promise<{ posted: boolean; reason?: string; message?: string; status?: number }>;
