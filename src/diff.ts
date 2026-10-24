import type { Hunk, HunkLine } from "./types";

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parsePatch(patch: string | undefined): Hunk[] {
  if (!patch) return [];
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const raw of patch.split("\n")) {
    const header = raw.match(HUNK_RE);
    if (header) {
      const oldStart = Number(header[1]);
      const oldCount = header[2] ? Number(header[2]) : 1;
      const newStart = Number(header[3]);
      const newCount = header[4] ? Number(header[4]) : 1;
      current = {
        header: raw,
        oldStart,
        oldCount,
        newStart,
        newCount,
        startLine: newStart,
        lines: [],
      };
      hunks.push(current);
      oldNo = oldStart;
      newNo = newStart;
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("\\")) continue;

    let line: HunkLine;
    if (raw.startsWith("+")) {
      line = { kind: "add", text: raw.slice(1), oldNo: null, newNo };
      newNo += 1;
    } else if (raw.startsWith("-")) {
      line = { kind: "del", text: raw.slice(1), oldNo, newNo: null };
      oldNo += 1;
    } else if (raw.startsWith(" ")) {
      const text = raw.slice(1);
      line = { kind: "ctx", text, oldNo, newNo };
      oldNo += 1;
      newNo += 1;
    } else {
      continue;
    }
    current.lines.push(line);
  }
  return hunks;
}

export function lineKey(path: string, line: number, side: string): string {
  return `${path}:${side}:${line}`;
}

export function commentable(line: HunkLine): { line: number; side: "RIGHT" | "LEFT" } | null {
  if (line.kind === "add" && line.newNo != null) return { line: line.newNo, side: "RIGHT" };
  if (line.kind === "ctx" && line.newNo != null) return { line: line.newNo, side: "RIGHT" };
  if (line.kind === "del" && line.oldNo != null) return { line: line.oldNo, side: "LEFT" };
  return null;
}
