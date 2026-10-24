import assert from "node:assert/strict";
import { createServer, preview } from "vite";

// The smoke check must never post a real review, even in a token-bearing shell.
delete process.env.GITHUB_TOKEN;

for (const mode of ["dev", "preview"]) {
  const server = mode === "dev"
    ? await createServer({ server: { host: "127.0.0.1", port: 0 } })
    : await preview({ preview: { host: "127.0.0.1", port: 0 } });
  try {
    if (mode === "dev") await server.listen();
    const address = server.httpServer.address();
    const origin = `http://127.0.0.1:${address.port}`;
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("origin-agent-cluster"), "?1");
    assert.equal(page.headers.get("permissions-policy"), "tools=(self)");
    const html = await page.text();
    assert.match(html, /<title>Hunk/);
    const script = html.match(/<script[^>]+src="([^"]+)"/);
    assert.ok(script, "page serves its JavaScript entry point");
    assert.equal((await fetch(new URL(script[1], origin))).status, 200);
    const snapshot = await (await fetch(`${origin}/demo-pr.json`)).json();
    assert.equal(snapshot.number, 31922);
    assert.ok(snapshot.files.length > 0);
    const invalid = await fetch(`${origin}/api/pr?url=not-a-pr`);
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /parse/);
    const review = await fetch(`${origin}/api/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner: "openai", repo: "codex", number: 31922, event: "APPROVE" }),
    });
    assert.equal(review.status, 200);
    assert.deepEqual(await review.json(), {
      posted: false, reason: "no_token", message: "Sealed here. Open on GitHub to post.",
    });
    console.log(`PASS ${mode}: served entry point, headers, snapshot, invalid PR and token-free review API`);
  } finally {
    if (mode === "dev") await server.close();
    else await new Promise((resolve, reject) => {
      server.httpServer.close((error) => error ? reject(error) : resolve());
    });
  }
}
