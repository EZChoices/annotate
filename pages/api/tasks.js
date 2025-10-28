// pages/api/tasks.js
import { promises as fs } from "fs";
import path from "path";

const MANIFEST_PATH = path.join(process.cwd(), "public", "manifest.json");

function safeParseInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function readManifestText() {
  return fs.readFile(MANIFEST_PATH, "utf8");
}

async function listPublicDir() {
  try {
    return await fs.readdir(path.join(process.cwd(), "public"));
  } catch (error) {
    return { error: error.message };
  }
}

export default async function handler(req, res) {
  const ts = new Date().toISOString();
  const stage = safeParseInt(req.query.stage || "2", 2);
  const annotator = req.query.annotator_id || "anonymous";

  console.log(
    `[api/tasks] ${ts} invoked`,
    JSON.stringify({ method: req.method, query: req.query, cwd: process.cwd() })
  );

  res.setHeader("x-debug-timestamp", ts);
  res.setHeader("x-debug-path", MANIFEST_PATH);

  let manifestText;
  try {
    manifestText = await readManifestText();
  } catch (error) {
    if (error.code === "ENOENT") {
      console.warn(`[api/tasks] manifest not found at ${MANIFEST_PATH}`);
      res.status(404).json({
        ok: false,
        error: "manifest_not_found",
        manifest_path: MANIFEST_PATH,
        cwd: process.cwd(),
        public_dir: await listPublicDir(),
      });
      return;
    }

    console.error("[api/tasks] read error", error);
    res.status(500).json({ ok: false, error: "manifest_read_failed" });
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    console.error("[api/tasks] manifest parse error", error);
    res.status(500).json({
      ok: false,
      error: "manifest_parse_failed",
      message: error.message,
    });
    return;
  }

  const payload =
    manifest && manifest.items
      ? manifest
      : manifest && manifest.manifest
      ? manifest.manifest
      : {};

  const items = Array.isArray(payload.items) ? payload.items : [];

  const response = {
    ok: true,
    annotator_id: payload.annotator_id || annotator,
    stage: payload.stage || stage,
    manifest_path: MANIFEST_PATH,
    manifest_items: items.length,
    sample_asset_id: items[0] ? items[0].asset_id || null : null,
    items,
    __source: "filesystem_manifest",
    debug_timestamp: ts,
  };

  console.log(
    `[api/tasks] ${ts} response`,
    JSON.stringify({
      manifest_items: response.manifest_items,
      sample_asset_id: response.sample_asset_id,
    })
  );

  res.status(200).json(response);
}
