/**
 * Proof: Hunk WebMCP tools register against the real store.
 * Mocks document.modelContext.registerTool.
 * Loads the baked openai/codex#31922 snapshot.
 * add_comment does not submit. set_verdict stays draft.
 * No submit_review / merge / approve_on_github tool.
 */
import * as esbuild from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const snapshot = JSON.parse(readFileSync(join(ROOT, "public/demo-pr.json"), "utf8"));

const registered = [];
const modelContext = {
  registerTool(tool, options) {
    registered.push({ tool, options });
  },
};

globalThis.window = globalThis;
globalThis.document = { modelContext };
Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });

const outdir = mkdtempSync(join(tmpdir(), "hunk-prove-"));
process.on("exit", () => rmSync(outdir, { recursive: true, force: true }));
const outfile = join(outdir, "webmcp-bundle.mjs");

await esbuild.build({
  absWorkingDir: ROOT,
  entryPoints: ["src/webmcp.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile,
  logLevel: "silent",
});

const mod = await import(pathToFileURL(outfile).href);
const { registerTools, TOOL_NAMES, getModelContext, getState, loadPrPayload } = mod;

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail ?? "" });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

const EXPECTED = [
  "import_pr",
  "list_files",
  "open_file",
  "get_hunks",
  "goto_hunk",
  "add_comment",
  "list_comments",
  "set_verdict",
];

const FORBIDDEN = ["submit_review", "merge", "approve_on_github", "submit", "post_review"];

const ac = new AbortController();
const names = await registerTools(ac.signal);

check("getModelContext() sees mock", getModelContext() === modelContext);
check("registerTools returns 8 names", Array.isArray(names) && names.length === 8, JSON.stringify(names));
check("TOOL_NAMES matches expected 8", JSON.stringify([...TOOL_NAMES]) === JSON.stringify(EXPECTED), JSON.stringify(TOOL_NAMES));
check("registerTool called 8 times", registered.length === 8, `count=${registered.length}`);
check(
  "every registerTool got AbortSignal",
  registered.every((r) => r.options?.signal === ac.signal),
);
check(
  "registered names match TOOL_NAMES",
  JSON.stringify(registered.map((r) => r.tool.name)) === JSON.stringify(EXPECTED),
);

const byName = Object.fromEntries(registered.map((r) => [r.tool.name, r.tool]));
for (const n of EXPECTED) {
  check(`tool present: ${n}`, typeof byName[n]?.execute === "function");
}
for (const n of FORBIDDEN) {
  check(`no ${n} tool`, !byName[n]);
}

function exec(name, args) {
  return byName[name].execute(args ?? {});
}

check("snapshot is openai/codex#31922", snapshot.owner === "openai" && snapshot.repo === "codex" && snapshot.number === 31922);
check("snapshot title is real", snapshot.title === "core: add tool-free thread mode", snapshot.title);
check(
  "snapshot has real Rust files",
  snapshot.files.some((f) => f.filename === "codex-rs/core/src/session/turn.rs") &&
    snapshot.files.some((f) => f.filename === "codex-rs/features/src/lib.rs") &&
    snapshot.files.some((f) => f.filename === "codex-rs/core/src/session/mcp.rs"),
);
check(
  "snapshot patches are real GitHub hunks",
  typeof snapshot.files.find((f) => f.filename.endsWith("turn.rs"))?.patch === "string" &&
    snapshot.files.find((f) => f.filename.endsWith("turn.rs")).patch.includes("Feature::ToolFree"),
);

const loaded = loadPrPayload(snapshot, "snapshot");
check("load snapshot returns PR", loaded?.number === 31922 && loaded?.title === snapshot.title);
check("state source is snapshot", getState().source === "snapshot");
check("not sealed after load", getState().sealed === null);

const listed = await exec("list_files");
check("list_files sees turn.rs", (listed.files ?? []).some((f) => f.filename.endsWith("turn.rs")), JSON.stringify((listed.files ?? []).map((f) => f.filename)));

const opened = await exec("open_file", { path: "codex-rs/core/src/session/turn.rs" });
check("open_file selects turn.rs", opened.filename === "codex-rs/core/src/session/turn.rs");

const hunks = await exec("get_hunks", { path: "codex-rs/core/src/session/turn.rs" });
check("get_hunks returns @@ hunks", Array.isArray(hunks.hunks) && hunks.hunks.length >= 1, JSON.stringify(hunks.hunks?.map((h) => h.start_line)));
const start = hunks.hunks[0].start_line;
const jumped = await exec("goto_hunk", { path: "codex-rs/core/src/session/turn.rs", start_line: start });
check("goto_hunk focuses hunk", jumped.start_line === start && getState().focusHunk?.startLine === start);

const comment = await exec("add_comment", {
  path: "codex-rs/core/src/session/turn.rs",
  line: 518,
  body: "ToolFree short-circuits skill injection. Confirm guardian path still applies when tools return.",
  side: "RIGHT",
});
check("add_comment returns a comment", typeof comment.id === "string" && comment.body.includes("ToolFree"));
check("add_comment actor is agent", comment.actor === "agent", `actor=${comment.actor}`);
check("add_comment does not submit", getState().sealed === null, `sealed=${JSON.stringify(getState().sealed)}`);
check("add_comment stays in draft list", getState().comments.length === 1);

const verdict = await exec("set_verdict", { verdict: "request_changes" });
check("set_verdict returns draft flag", verdict.verdict === "request_changes" && verdict.sealed === false);
check("set_verdict still draft", getState().sealed === null && getState().verdict === "request_changes");

const listedComments = await exec("list_comments");
check("list_comments sealed=false", listedComments.sealed === false);
check("list_comments has the agent draft", listedComments.comments?.[0]?.actor === "agent");

const readOnly = byName.list_files.annotations?.readOnlyHint && byName.get_hunks.annotations?.readOnlyHint && byName.list_comments.annotations?.readOnlyHint;
check("read tools marked readOnlyHint", readOnly);

function printSummary() {
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log("");
  console.log("==== PROVE-TOOLS SUMMARY ====");
  console.log(`passed=${passed} failed=${failed} total=${results.length}`);
  if (failed) {
    console.log("FAILED:");
    for (const r of results.filter((x) => !x.pass)) {
      console.log(`  - ${r.name}${r.detail ? " — " + r.detail : ""}`);
    }
  }
  console.log(failed === 0 ? "RESULT: ALL PASS" : "RESULT: FAIL");
}

printSummary();
process.exit(results.every((r) => r.pass) ? 0 : 1);
