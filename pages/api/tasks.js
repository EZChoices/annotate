// pages/api/tasks.js
import { promises as fs } from "fs";
import path from "path";

const MANIFEST_PATH = path.join(process.cwd(), "public", "manifest.json");

function safeParseInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export default async function handler(req, res) {
  const stage = safeParseInt(req.query.stage || "2", 2);
  const annotator = req.query.annotator_id || "anonymous";

  try {
    const manifestText = await fs.readFile(MANIFEST_PATH, "utf8");
    const manifest = JSON.parse(manifestText);

    // Some generators wrap the manifest under a "manifest" key; normalize it.
    const payload =
      manifest && manifest.items
        ? manifest
        : manifest && manifest.manifest
        ? manifest.manifest
        : {};

    const items = Array.isArray(payload.items) ? payload.items : [];

    res.status(200).json({
      annotator_id: payload.annotator_id || annotator,
      stage: payload.stage || stage,
      items,
      __source: "filesystem_manifest",
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      res
        .status(404)
        .json({ error: "manifest_not_found", manifest_path: MANIFEST_PATH });
      return;
    }

    console.error("[/api/tasks] error reading manifest:", error);
    res.status(500).json({ error: "manifest_read_failed" });
  }
}
