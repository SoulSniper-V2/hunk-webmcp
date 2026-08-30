import { fetchPullRequest, parsePrRef } from "./github.mjs";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "GET only" });
    return;
  }

  try {
    const url = new URL(req.url, "http://localhost");
    const ref = parsePrRef({
      url: url.searchParams.get("url") || "",
      owner: url.searchParams.get("owner") || "",
      repo: url.searchParams.get("repo") || "",
      number: url.searchParams.get("number") || "",
    });
    const data = await fetchPullRequest(ref);
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    res.status(200).json(data);
  } catch (err) {
    const status = err.status || 400;
    res.status(status).json({
      error: err.message || "Failed to load pull request",
      code: err.code || undefined,
    });
  }
}
