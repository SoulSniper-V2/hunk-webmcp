import {
  addComment,
  getHunks,
  getState,
  gotoHunk,
  importPr,
  listComments,
  listFiles,
  loadPrPayload,
  openFile,
  setVerdict,
} from "./store";
import { VERDICTS } from "./types";
import type { Verdict } from "./types";
import type { ModelContext, WebMcpTool } from "./vite-env";

export const TOOL_NAMES = [
  "import_pr",
  "list_files",
  "open_file",
  "get_hunks",
  "goto_hunk",
  "add_comment",
  "list_comments",
  "set_verdict",
] as const;

export { getState, loadPrPayload };

function str(args: Record<string, unknown>, key: string, required = false): string {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new Error(`${key} is required`);
    return "";
  }
  if (typeof v !== "string") throw new Error(`${key} must be a string`);
  return v;
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  if (!(key in args) || args[key] === undefined || args[key] === "") return undefined;
  return str(args, key);
}

function num(args: Record<string, unknown>, key: string, required = false): number | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new Error(`${key} is required`);
    return undefined;
  }
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
  return n;
}

function wrap(fn: (args: Record<string, unknown>) => unknown | Promise<unknown>) {
  return async (args: Record<string, unknown>) => {
    try {
      return await fn(args ?? {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  };
}

const tools: WebMcpTool[] = [
  {
    name: "import_pr",
    description:
      "Load a public GitHub pull request into Hunk. Pass a github.com PR URL, owner/repo#number, or owner + repo + number. Replaces the current diff and clears draft comments. Does not submit a review.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string", description: "https://github.com/owner/repo/pull/123 or owner/repo#123" },
        owner: { type: "string" },
        repo: { type: "string" },
        number: { type: "number" },
      },
    },
    execute: wrap((args) =>
      importPr({
        url: optStr(args, "url"),
        owner: optStr(args, "owner"),
        repo: optStr(args, "repo"),
        number: num(args, "number"),
      }),
    ),
  },
  {
    name: "list_files",
    description: "List files in the loaded pull request with additions, deletions, and hunk counts.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    execute: wrap(() => listFiles()),
  },
  {
    name: "open_file",
    description: "Select a file in the diff viewer so the human can see it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", description: "File path in the pull request" },
      },
    },
    execute: wrap((args) => openFile(str(args, "path", true))),
  },
  {
    name: "get_hunks",
    description: "Return parsed diff hunks for a file (@@ headers and start lines). Parse happens client-side.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string" },
      },
    },
    execute: wrap((args) => getHunks(str(args, "path", true))),
  },
  {
    name: "goto_hunk",
    description: "Jump the diff viewer to a hunk by file path and start_line (the + side start from the @@ header).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path", "start_line"],
      properties: {
        path: { type: "string" },
        start_line: { type: "number" },
      },
    },
    execute: wrap((args) => gotoHunk(str(args, "path", true), num(args, "start_line", true)!)),
  },
  {
    name: "add_comment",
    description:
      "Draft a line comment as the agent. Does NOT submit the review. The human must click Submit review. Refused after the review is sealed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path", "line", "body"],
      properties: {
        path: { type: "string" },
        line: { type: "number", description: "Line number on the chosen side" },
        body: { type: "string" },
        side: { type: "string", enum: ["RIGHT", "LEFT"], description: "RIGHT for additions/context, LEFT for deletions" },
      },
    },
    execute: wrap((args) =>
      addComment({
        path: str(args, "path", true),
        line: num(args, "line", true)!,
        body: str(args, "body", true),
        side: optStr(args, "side") === "LEFT" ? "LEFT" : "RIGHT",
        actor: "agent",
      }),
    ),
  },
  {
    name: "list_comments",
    description: "List draft line comments and the current verdict. Comments stay draft until a human submits.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    execute: wrap(() => listComments()),
  },
  {
    name: "set_verdict",
    description:
      "Set the draft review verdict: comment, request_changes, or approve. Does NOT submit. Still a draft. The human submits.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["verdict"],
      properties: {
        verdict: { type: "string", enum: [...VERDICTS] },
      },
    },
    execute: wrap((args) => {
      const verdict = str(args, "verdict", true) as Verdict;
      return setVerdict(verdict);
    }),
  },
];

export function getModelContext(): ModelContext | null {
  const ctx = document.modelContext ?? navigator.modelContext;
  if (typeof ctx?.registerTool === "function") return ctx;
  return null;
}

export function registerTools(signal: AbortSignal): string[] {
  const ctx = getModelContext();
  if (!ctx) return [];
  const names: string[] = [];
  for (const tool of tools) {
    ctx.registerTool(tool, { signal });
    names.push(tool.name);
  }
  return names;
}
