import { postPullRequestReview } from "./github.mjs";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const owner = String(body.owner || "").trim();
    const repo = String(body.repo || "").trim();
    const number = Number(body.number);
    const event = body.event;
    if (!owner || !repo || !Number.isFinite(number)) {
      res.status(400).json({ posted: false, reason: "bad_request", message: "owner, repo, and number are required" });
      return;
    }
    if (!["COMMENT", "REQUEST_CHANGES", "APPROVE"].includes(event)) {
      res.status(400).json({ posted: false, reason: "bad_request", message: "event must be COMMENT, REQUEST_CHANGES, or APPROVE" });
      return;
    }
    const result = await postPullRequestReview({
      owner,
      repo,
      number,
      event,
      body: String(body.body || ""),
      comments: Array.isArray(body.comments) ? body.comments : [],
    });
    res.status(200).json(result);
  } catch (err) {
    res.status(200).json({
      posted: false,
      reason: "error",
      message: "Sealed here. Open on GitHub to post.",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
