const fs = require("fs");
const path = require("path");

const PUBLIC_DIR = path.join(process.cwd(), "public");
const DATA_DIR = path.join(PUBLIC_DIR, "data");
const OUTPUT_PATH = path.join(PUBLIC_DIR, "manifest.json");

function safeReadDir(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    return null;
  }
}

function findPrefillFiles(dir) {
  const entries = safeReadDir(dir);
  if (!entries) return [];

  let results = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(findPrefillFiles(entryPath));
    } else if (
      entry.name.toLowerCase().endsWith('.vtt') ||
      entry.name.toLowerCase().endsWith('.rttm') ||
      entry.name.toLowerCase().endsWith('.json')
    ) {
      results.push(entryPath);
    }
  }
  return results;
}

function toPublicUrl(absPath) {
  const relFromPublic = path.relative(PUBLIC_DIR, absPath).replace(/\\/g, "/");
  return "/" + relFromPublic;
}

function buildManifest() {
  const items = [];

  if (!fs.existsSync(DATA_DIR)) {
    console.warn("⚠️  No /public/data directory found. Writing empty manifest.");
    fs.writeFileSync(
      OUTPUT_PATH,
      JSON.stringify({ annotator_id: "auto", stage: 2, items }, null, 2)
    );
    return;
  }

  const stageEntries = (safeReadDir(DATA_DIR) || []).filter((entry) => entry.isDirectory());

  for (const stageEntry of stageEntries) {
    const stage = stageEntry.name;
    const stagePath = path.join(DATA_DIR, stage);
    const clipEntries = (safeReadDir(stagePath) || []).filter((entry) => entry.isDirectory());

    for (const clipEntry of clipEntries) {
      const clip = clipEntry.name;
      const clipPath = path.join(stagePath, clip);
      const files = findPrefillFiles(clipPath);

      const pref = {};
      for (const file of files) {
        const lower = file.toLowerCase();
        const url = toPublicUrl(file);
        if (lower.endsWith('diarization.rttm')) pref.diarization_rttm_url = url;
        else if (lower.includes('transcript') && lower.endsWith('.vtt')) pref.transcript_vtt_url = url;
        else if (lower.includes('translation') && lower.endsWith('.vtt')) pref.translation_vtt_url = url;
        else if (lower.includes('emotion') && lower.endsWith('.vtt')) pref.emotion_vtt_url = url;
        else if (lower.includes('events') && lower.endsWith('.vtt')) pref.events_vtt_url = url;
        else if (lower.includes('code_switch_spans') && lower.endsWith('.json')) pref.code_switch_spans_url = url;
      }

      items.push({
        asset_id: clip,
        media: {
          audio_proxy_url: "/sample.mp4",
          video_hls_url: null,
          poster_url: null,
        },
        prefill: {
          diarization_rttm_url: pref.diarization_rttm_url || null,
          transcript_vtt_url: pref.transcript_vtt_url || null,
          transcript_ctm_url: null,
          translation_vtt_url: pref.translation_vtt_url || null,
          code_switch_vtt_url: null,
          events_vtt_url: pref.events_vtt_url || null,
          emotion_vtt_url: pref.emotion_vtt_url || null,
          code_switch_spans_url: pref.code_switch_spans_url || null,
        },
        stage0_status: 'seed',
        stage1_status: 'seed',
        language_hint: 'ar',
        notes: 'auto-generated',
        assigned_cell: 'unknown:unknown:unknown:unknown',
        double_pass_target: false,
        pass_number: 1,
        previous_annotators: [],
      });
    }
  }

  const manifest = {
    annotator_id: "auto",
    stage: 2,
    items,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(manifest, null, 2));
  console.log(`✅ Manifest built with ${items.length} items → ${OUTPUT_PATH}`);
}

module.exports = { buildManifest };

if (require.main === module) {
  buildManifest();
}
