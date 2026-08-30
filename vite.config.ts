import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// JS helper shared with Vercel /api — types live in api/github.mjs.d.ts
// @ts-expect-error module is plain JS
import { fetchPullRequest, parsePrRef, postPullRequestReview } from "./api/github.mjs";

const headers = {
  "Origin-Agent-Cluster": "?1",
  "Permissions-Policy": "tools=(self)",
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    req.on("data", (c: Uint8Array) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

async function handleApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const raw = req.url || "/";
  const url = new URL(raw, "http://localhost");

  if (url.pathname === "/api/pr" && req.method === "GET") {
    try {
      const ref = parsePrRef({
        url: url.searchParams.get("url") || "",
        owner: url.searchParams.get("owner") || "",
        repo: url.searchParams.get("repo") || "",
        number: url.searchParams.get("number") || "",
      });
      sendJson(res, 200, await fetchPullRequest(ref));
    } catch (err) {
      const e = err as { status?: number; code?: string; message?: string };
      sendJson(res, e.status || 400, { error: e.message || "Failed to load pull request", code: e.code });
    }
    return;
  }

  if (url.pathname === "/api/review" && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}") as {
        owner?: string;
        repo?: string;
        number?: number;
        event?: string;
        body?: string;
        comments?: Array<{ path: string; line: number; body: string; side?: string }>;
      };
      const event = String(body.event);
      if (!["COMMENT", "REQUEST_CHANGES", "APPROVE"].includes(event)) {
        sendJson(res, 400, {
          posted: false,
          reason: "bad_request",
          message: "event must be COMMENT, REQUEST_CHANGES, or APPROVE",
        });
        return;
      }
      sendJson(
        res,
        200,
        await postPullRequestReview({
          owner: String(body.owner || ""),
          repo: String(body.repo || ""),
          number: Number(body.number),
          event: event as "COMMENT" | "REQUEST_CHANGES" | "APPROVE",
          body: String(body.body || ""),
          comments: body.comments || [],
        }),
      );
    } catch (err) {
      sendJson(res, 200, {
        posted: false,
        reason: "error",
        message: "Sealed here. Open on GitHub to post.",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  next();
}

function apiPlugin(): Plugin {
  return {
    name: "hunk-github-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void handleApi(req, res, next);
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        void handleApi(req, res, next);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), apiPlugin()],
  server: { headers, host: true, port: 5173 },
  preview: { headers, host: true, port: 4173 },
});
