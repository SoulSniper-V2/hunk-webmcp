import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setImmediate as nextTurn } from "node:timers/promises";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = JSON.parse(await readFile(join(root, "public/demo-pr.json"), "utf8"));
const expectedTools = ["import_pr", "list_files", "open_file", "get_hunks", "goto_hunk", "add_comment", "list_comments", "set_verdict"];
const globalNames = ["fetch", "navigator", "document"];
const originals = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let outdir;
let store;
let webmcp;
let diff;

function replaceGlobal(name, value) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function restoreGlobals() {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function response(payload, ok = true) {
  return { ok, json: async () => payload };
}

function payload(number) {
  return { ...structuredClone(fixture), number, html_url: `https://github.com/${fixture.owner}/${fixture.repo}/pull/${number}` };
}

function ref(number) {
  return { owner: fixture.owner, repo: fixture.repo, number };
}

const commentInput = {
  path: fixture.files[0].filename,
  line: 4,
  side: "RIGHT",
  body: "Check the feature guard.",
  actor: "agent",
};

function expectedBody(verdict) {
  const label = { comment: "Comment", approve: "Approve", request_changes: "Request changes" }[verdict];
  return [
    "## Review (Hunk)", "", `**Verdict:** ${label}`, "",
    `### \`${commentInput.path}\` (L4, RIGHT)`, "", commentInput.body, "", "— agent", "",
    "---", `Drafted in [Hunk](${fixture.html_url}). Same diff. You submit.`,
  ].join("\n");
}

async function assertSubmittingLocks() {
  const unchanged = structuredClone(store.getState());
  assert.equal(unchanged.submitting, true);
  assert.match(store.submitDisabledReason(), /submitt/i);
  await assert.rejects(store.submitReview(), /submitt/i);
  assert.throws(() => store.addComment(commentInput), /submitt/i);
  assert.throws(() => store.setVerdict("approve"), /submitt/i);
  await assert.rejects(store.importPr(ref(101)), /submi/i);
  assert.throws(() => store.loadPrPayload(payload(102)), /submi/i);
  assert.deepEqual(store.getState(), unchanged);
}

describe("store and WebMCP regressions", { concurrency: false, timeout: 30_000 }, () => {
  before(async () => {
    outdir = await mkdtemp(join(tmpdir(), "hunk-regressions-"));
    process.once("exit", cleanupOnExit);
    // Splitting keeps WebMCP and the directly tested store on the same singleton.
    await build({
      absWorkingDir: root,
      entryPoints: { store: "src/store.ts", webmcp: "src/webmcp.ts", diff: "src/diff.ts" },
      outdir,
      outExtension: { ".js": ".mjs" },
      bundle: true,
      splitting: true,
      format: "esm",
      platform: "node",
      logLevel: "silent",
    });
    [store, webmcp, diff] = await Promise.all(
      ["store", "webmcp", "diff"].map((name) => import(pathToFileURL(join(outdir, `${name}.mjs`)).href)),
    );
  });

  function cleanupOnExit() {
    if (outdir) rmSync(outdir, { recursive: true, force: true });
  }

  beforeEach(() => {
    replaceGlobal("fetch", () => { throw new Error("Unexpected fetch: all requests must be mocked"); });
    replaceGlobal("navigator", {});
    replaceGlobal("document", {});
    store.loadPrPayload(structuredClone(fixture));
  });
  afterEach(restoreGlobals);
  after(async () => {
    restoreGlobals();
    if (outdir) await rm(outdir, { recursive: true, force: true });
    process.removeListener("exit", cleanupOnExit);
  });

  it("parses only actual diff rows without shifting line numbers for malformed or blank lines", () => {
    const patch = "ignored preamble\n@@ -10,3 +20,3 @@\n context\nmalformed\n\n-old\n\\ No newline at end of file\n+new\n \n\ninvalid trailer\n";
    const hunks = diff.parsePatch(patch);
    assert.equal(hunks.length, 1);
    assert.deepEqual(hunks[0].lines, [
      { kind: "ctx", text: "context", oldNo: 10, newNo: 20 },
      { kind: "del", text: "old", oldNo: 11, newNo: null },
      { kind: "add", text: "new", oldNo: null, newNo: 21 },
      { kind: "ctx", text: "", oldNo: 12, newNo: 22 },
    ]);
    assert.deepEqual(hunks[0].lines.map(diff.commentable), [
      { line: 20, side: "RIGHT" }, { line: 11, side: "LEFT" },
      { line: 21, side: "RIGHT" }, { line: 22, side: "RIGHT" },
    ]);
    assert.deepEqual(diff.parsePatch(undefined), []);
    assert.deepEqual(diff.parsePatch(""), []);
  });

  it("comments require a positive safe integer and a visible line on its commentable side", () => {
    const pr = structuredClone(fixture);
    pr.files[0].patch = "@@ -10,2 +20,2 @@\n context\n-old\n+new\n\nmalformed\n";
    store.loadPrPayload(pr);
    for (const line of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => store.addComment({ ...commentInput, line }));
    }
    for (const side of ["left", "BOTH", "", 1]) {
      assert.throws(() => store.addComment({ ...commentInput, line: 20, side }));
    }
    for (const [line, side] of [[10, "LEFT"], [11, "RIGHT"], [21, "LEFT"], [23, "RIGHT"], [999, "RIGHT"]]) {
      assert.throws(() => store.addComment({ ...commentInput, line, side }));
    }
    assert.equal(store.getState().comments.length, 0);
    for (const [line, side] of [[20, "RIGHT"], [11, "LEFT"], [21, "RIGHT"]]) {
      assert.deepEqual(store.addComment({ ...commentInput, line, side }), {
        ...commentInput, line, side, id: store.getState().comments.at(-1).id,
      });
    }
    assert.equal(store.addComment({ ...commentInput, line: 20, side: undefined }).side, "RIGHT");
  });

  for (const [verdict, fails] of [["comment", false], ["approve", false], ["request_changes", true]]) {
    it(`locks before clipboard/fetch and seals the captured ${verdict} review${fails ? " after network failure" : ""}`, async () => {
      const clipboard = deferred();
      const network = deferred();
      const copied = [];
      const requests = [];
      replaceGlobal("navigator", { clipboard: { writeText(body) { copied.push(body); return clipboard.promise; } } });
      replaceGlobal("fetch", (url, options) => { requests.push({ url, options }); return network.promise; });
      store.addComment(commentInput);
      store.setVerdict(verdict);
      const captured = structuredClone(store.getState().comments);
      assert.equal(store.submitDisabledReason(), null);
      const pending = store.submitReview();
      assert.equal(store.getState().submitting, true, "lock must be synchronous");
      assert.deepEqual(copied, [expectedBody(verdict)]);
      assert.equal(requests.length, 0, "fetch waits for clipboard");
      await assertSubmittingLocks();
      if (fails) clipboard.reject(new Error("Clipboard permission denied"));
      else clipboard.resolve();
      await nextTurn();
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, "/api/review");
      assert.equal(requests[0].options.method, "POST");
      assert.deepEqual(JSON.parse(requests[0].options.body), {
        owner: fixture.owner, repo: fixture.repo, number: fixture.number,
        event: { comment: "COMMENT", approve: "APPROVE", request_changes: "REQUEST_CHANGES" }[verdict],
        body: expectedBody(verdict),
        comments: [{ path: commentInput.path, line: 4, side: "RIGHT", body: commentInput.body }],
      });
      await assertSubmittingLocks();
      if (fails) network.reject(new Error("Network unavailable"));
      else network.resolve(response({ posted: true }));
      const receipt = await pending;
      assert.equal(receipt.verdict, verdict);
      assert.equal(receipt.body, expectedBody(verdict));
      assert.deepEqual(receipt.comments, captured);
      assert.equal(receipt.prUrl, fixture.html_url);
      assert.equal(receipt.githubPosted, !fails);
      assert.ok(Number.isFinite(Date.parse(receipt.timestamp)));
      assert.deepEqual(store.getState().sealed, receipt);
      assert.equal(store.getState().submitting, false);
      assert.match(store.submitDisabledReason(), /sealed/i);
      await assert.rejects(store.submitReview(), /sealed/i);
      assert.throws(() => store.addComment(commentInput), /sealed/i);
      assert.throws(() => store.setVerdict("comment"), /sealed/i);
      assert.equal(requests.length, 1);
    });
  }

  it("seals without browser clipboard APIs when the server refuses a review", async () => {
    delete globalThis.navigator;
    replaceGlobal("fetch", async () => response({ posted: false, message: "Read-only preview" }, false));
    store.setVerdict("approve");
    const pending = store.submitReview();
    assert.equal(store.getState().submitting, true);
    const receipt = await pending;
    assert.equal(receipt.githubPosted, false);
    assert.equal(receipt.githubMessage, "Read-only preview");
    assert.equal(receipt.verdict, "approve");
    assert.deepEqual(receipt.comments, []);
    assert.match(receipt.body, /No line comments/);
    assert.equal(store.getState().submitting, false);
  });

  it("loading blocks draft changes and submission; failure preserves the PR and displays its error", async () => {
    store.addComment(commentInput);
    store.setVerdict("request_changes");
    const before = structuredClone(store.getState());
    const network = deferred();
    replaceGlobal("fetch", () => network.promise);
    const pending = store.importPr(ref(100));
    const rejected = assert.rejects(pending, /Unavailable/);
    assert.equal(store.getState().loading, true);
    assert.match(store.submitDisabledReason(), /load/i);
    assert.throws(() => store.addComment(commentInput), /load/i);
    assert.throws(() => store.setVerdict("approve"), /load/i);
    await assert.rejects(store.submitReview(), /load/i);
    network.resolve(response({ error: "Unavailable" }, false));
    await rejected;
    assert.deepEqual(store.getState(), { ...before, loading: false, error: "Unavailable" });
  });

  for (const winner of ["import", "direct load"]) {
    for (const phase of ["response", "JSON body", "snapshot fallback"]) {
      it(`${winner} supersedes an older pending ${phase} without stale state changes`, async () => {
        const stale = deferred();
        const fallbackStarted = deferred();
        const calls = [];
        replaceGlobal("fetch", (url) => {
          calls.push(url);
          if (url === "/demo-pr.json") { fallbackStarted.resolve(); return stale.promise; }
          if (url.includes("number=202")) return Promise.resolve(response(payload(202)));
          if (phase === "snapshot fallback") return Promise.reject(new Error("Offline"));
          if (phase === "JSON body") return Promise.resolve({ ok: true, json: () => stale.promise });
          return stale.promise;
        });
        const older = store.importPr(ref(phase === "snapshot fallback" ? fixture.number : 101));
        const rejected = assert.rejects(older, /supersed/i);
        if (phase === "snapshot fallback") await fallbackStarted.promise;
        else await nextTurn();
        if (winner === "import") await store.importPr(ref(202));
        else store.loadPrPayload(payload(202));
        store.addComment(commentInput);
        store.setVerdict("approve");
        const newest = structuredClone(store.getState());
        stale.resolve(phase === "JSON body" ? payload(101) : response(payload(101)));
        await rejected;
        assert.deepEqual(store.getState(), newest);
        assert.equal(store.getState().pr.number, 202);
        assert.equal(calls.filter((url) => url === "/demo-pr.json").length, phase === "snapshot fallback" ? 1 : 0);
      });
    }
  }

  it("an older response cannot clear loading while the newer import is still pending", async () => {
    const first = deferred();
    const second = deferred();
    replaceGlobal("fetch", (url) => url.includes("number=101") ? first.promise : second.promise);
    const rejected = assert.rejects(store.importPr(ref(101)), /supersed/i);
    const newer = store.importPr(ref(202));
    const loading = structuredClone(store.getState());
    first.resolve(response(payload(101)));
    await rejected;
    assert.deepEqual(store.getState(), loading);
    assert.equal(store.getState().loading, true);
    second.resolve(response(payload(202)));
    await newer;
    assert.equal(store.getState().pr.number, 202);
    assert.equal(store.getState().loading, false);
  });

  it("failed snapshot fallback preserves the current draft and leaves a visible error", async () => {
    store.loadPrPayload(payload(303));
    store.addComment(commentInput);
    const before = structuredClone(store.getState());
    replaceGlobal("fetch", async (url) => {
      if (url === "/demo-pr.json") return response({}, false);
      throw new Error("Offline");
    });
    await assert.rejects(store.importPr(ref(fixture.number)), /snapshot/i);
    assert.deepEqual(store.getState().pr, before.pr);
    assert.deepEqual(store.getState().comments, before.comments);
    assert.equal(store.getState().loading, false);
    assert.match(store.getState().error, /snapshot/i);
  });

  it("a stale default import failure cannot start snapshot fallback or replace a newer error", async () => {
    const stale = deferred();
    const calls = [];
    replaceGlobal("fetch", (url) => {
      calls.push(url);
      return url.includes(`number=${fixture.number}`) ? stale.promise : Promise.resolve(response({ error: "Newest import failed" }, false));
    });
    const rejected = assert.rejects(store.importPr(ref(fixture.number)), /supersed/i);
    await assert.rejects(store.importPr(ref(202)), /Newest import failed/);
    const newest = structuredClone(store.getState());
    stale.reject(new Error("Stale network failure"));
    await rejected;
    assert.deepEqual(store.getState(), newest);
    assert.equal(store.getState().pr.number, fixture.number);
    assert.ok(!calls.includes("/demo-pr.json"));
  });

  it("current default import uses the existing snapshot after a network failure", async () => {
    const calls = [];
    replaceGlobal("fetch", async (url) => {
      calls.push(url);
      if (url === "/demo-pr.json") return response(structuredClone(fixture));
      throw new Error("Offline");
    });
    const loaded = await store.importPr(ref(fixture.number));
    assert.equal(loaded.number, fixture.number);
    assert.equal(store.getState().source, "snapshot");
    assert.equal(store.getState().loading, false);
    assert.equal(store.getState().error, null);
    assert.equal(calls.length, 2);
    assert.equal(calls[1], "/demo-pr.json");
  });

  it("finds valid document/navigator contexts and safely handles missing or unusable APIs", async () => {
    const valid = { registerTool() {} };
    delete globalThis.document;
    delete globalThis.navigator;
    assert.equal(webmcp.getModelContext(), null);
    assert.deepEqual(await webmcp.registerTools(new AbortController().signal), []);
    replaceGlobal("navigator", { modelContext: valid });
    assert.equal(webmcp.getModelContext(), valid);
    for (const modelContext of [undefined, null, {}, { registerTool: true }]) {
      replaceGlobal("document", { modelContext });
      assert.equal(webmcp.getModelContext(), valid);
    }
    const preferred = { registerTool() {} };
    replaceGlobal("document", { modelContext: preferred });
    assert.equal(webmcp.getModelContext(), preferred);
    delete globalThis.navigator;
    assert.equal(webmcp.getModelContext(), preferred);
    replaceGlobal("document", {});
    assert.equal(webmcp.getModelContext(), null);
  });

  it("awaits asynchronous registration, forwards the signal, and exposes only draft tools", async () => {
    const first = deferred();
    const registered = [];
    replaceGlobal("document", { modelContext: { registerTool(tool, options) {
      registered.push({ tool, options });
      return registered.length === 1 ? first.promise : Promise.resolve();
    } } });
    const controller = new AbortController();
    let settled = false;
    const pending = webmcp.registerTools(controller.signal);
    assert.ok(pending instanceof Promise);
    pending.then(() => { settled = true; });
    await nextTurn();
    assert.equal(settled, false);
    assert.equal(registered.length, 1);
    first.resolve();
    assert.deepEqual(await pending, expectedTools);
    assert.deepEqual([...webmcp.TOOL_NAMES], expectedTools);
    assert.deepEqual(registered.map(({ tool }) => tool.name), expectedTools);
    assert.ok(registered.every(({ options }) => options.signal === controller.signal));
    const byName = Object.fromEntries(registered.map(({ tool }) => [tool.name, tool]));
    const added = await byName.add_comment.execute(commentInput);
    assert.equal(added.actor, "agent");
    await byName.set_verdict.execute({ verdict: "request_changes" });
    assert.equal(store.getState().comments.length, 1);
    assert.equal(store.getState().verdict, "request_changes");
    assert.equal(store.getState().sealed, null);
    assert.equal(store.getState().submitting, false);
    const invalid = await byName.add_comment.execute({ ...commentInput, line: 999999 });
    assert.equal(invalid.ok, false);
    assert.equal(store.getState().comments.length, 1);
  });

  it("propagates an asynchronous registration rejection and stops registering", async () => {
    const gate = deferred();
    const failure = new Error("Browser registration rejected");
    const calls = [];
    replaceGlobal("navigator", { modelContext: { registerTool(tool) {
      calls.push(tool.name);
      return calls.length === 2 ? gate.promise : Promise.resolve();
    } } });
    const pending = webmcp.registerTools(new AbortController().signal);
    const rejected = assert.rejects(pending, (err) => err === failure);
    await nextTurn();
    assert.equal(calls.length, 2);
    gate.reject(failure);
    await rejected;
    assert.deepEqual(calls, expectedTools.slice(0, 2));
  });

  it("preaborted registration returns an empty list without calling the API", async () => {
    let calls = 0;
    replaceGlobal("document", { modelContext: { registerTool() { calls += 1; } } });
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(await webmcp.registerTools(controller.signal), []);
    assert.equal(calls, 0);
  });

  it("abort during asynchronous registration returns an empty list and never continues", async () => {
    const gate = deferred();
    const calls = [];
    replaceGlobal("document", { modelContext: { registerTool(tool) {
      calls.push(tool.name);
      return gate.promise;
    } } });
    const controller = new AbortController();
    const pending = webmcp.registerTools(controller.signal);
    assert.equal(calls.length, 1);
    controller.abort();
    gate.resolve();
    assert.deepEqual(await pending, []);
    assert.deepEqual(calls, [expectedTools[0]]);
  });
});
