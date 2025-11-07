#!/usr/bin/env node

/**
 * Stitch microtask annotations back into per-asset bundles.
 * Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/stitch_dataset.js
 */

const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.SUPABASE_PROJECT_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    "Missing Supabase credentials. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
  );
  process.exit(1);
}

const OUTPUT_DIR =
  process.env.MOBILE_STITCH_OUTPUT ||
  path.join(process.cwd(), "stitch_output");

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
  });

  console.log("Fetching approved annotations…");
  const { data, error } = await supabase
    .from("task_responses")
    .select(
      `
        task_id,
        payload,
        contributor_id,
        created_at,
        tasks:tasks!inner(
          task_type,
          status,
          clip:clips(
            id,
            start_ms,
            end_ms,
            overlap_ms,
            asset_id,
            media_assets:media_assets(id, uri, duration_ms)
          )
        )
      `
    )
    .limit(50000);
  if (error) throw error;

  const grouped = new Map();
  for (const row of data || []) {
    const task = row.tasks;
    if (!task || !["auto_approved", "complete"].includes(task.status)) continue;
    const clip = task.clip;
    if (!clip?.asset_id) continue;
    const assetId = clip.asset_id;
    if (!grouped.has(assetId)) {
      grouped.set(assetId, {
        asset_id: assetId,
        asset_uri: clip.media_assets?.uri ?? null,
        clips: new Map(),
      });
    }
    const assetGroup = grouped.get(assetId);
    if (!assetGroup.clips.has(clip.id)) {
      assetGroup.clips.set(clip.id, {
        clip_id: clip.id,
        start_ms: clip.start_ms,
        end_ms: clip.end_ms,
        overlap_ms: clip.overlap_ms,
        tasks: [],
      });
    }
    assetGroup.clips.get(clip.id).tasks.push({
      task_id: row.task_id,
      task_type: task.task_type,
      payload: row.payload,
      contributor_id: row.contributor_id,
      created_at: row.created_at,
      status: task.status,
    });
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const manifestEntries = [];

  for (const asset of grouped.values()) {
    const clips = Array.from(asset.clips.values()).sort(
      (a, b) => a.start_ms - b.start_ms
    );
    const fileData = {
      asset_id: asset.asset_id,
      asset_uri: asset.asset_uri,
      clips,
    };
    const filename = `asset_${asset.asset_id}.json`;
    const filepath = path.join(OUTPUT_DIR, filename);
    fs.writeFileSync(filepath, JSON.stringify(fileData, null, 2));
    manifestEntries.push(filename);
  }

  const manifest = {
    generated_at: new Date().toISOString(),
    asset_count: grouped.size,
    files: manifestEntries,
  };
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );

  console.log(`Wrote ${grouped.size} asset bundles to ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

