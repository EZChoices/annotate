import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'public', 'data');
const OUTPUT_PATH = path.join(process.cwd(), 'public', 'manifest.json');

function safeReadDir(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    return null;
  }
}

function findVTTFiles(dir) {
  const entries = safeReadDir(dir);
  if (!entries) return [];

  let results = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(findVTTFiles(entryPath));
    } else if (entry.name.toLowerCase().endsWith('.vtt')) {
      results.push(entryPath);
    }
  }
  return results;
}

function buildManifest() {
  const clips = [];

  if (!fs.existsSync(DATA_DIR)) {
    console.warn('⚠️  No /public/data directory found. Writing empty manifest.');
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(clips, null, 2));
    return;
  }

  const stageFolders = safeReadDir(DATA_DIR) || [];
  for (const stageEntry of stageFolders) {
    if (!stageEntry.isDirectory()) continue;
    const stage = stageEntry.name;
    const stagePath = path.join(DATA_DIR, stage);

    const clipFolders = safeReadDir(stagePath) || [];
    for (const clipEntry of clipFolders) {
      if (!clipEntry.isDirectory()) continue;
      const clip = clipEntry.name;
      const clipPath = path.join(stagePath, clip);

      const files = findVTTFiles(clipPath);
      const entry = {
        id: clip,
        name: clip.replace(/_/g, ' '),
        stage,
      };

      for (const file of files) {
        const filename = path.basename(file).toLowerCase();
        const rel = '/' + path.relative(process.cwd(), file).replace(/\\/g, '/');
        if (filename.includes('transcript')) {
          entry.transcript_url = rel;
        } else if (filename.includes('translation')) {
          entry.translation_url = rel;
        } else if (filename.includes('emotion')) {
          entry.emotion_url = rel;
        } else if (filename.includes('events')) {
          entry.events_url = rel;
        }
      }

      clips.push(entry);
    }
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(clips, null, 2));
  console.log(`✅ Manifest built with ${clips.length} clips → ${OUTPUT_PATH}`);
}

buildManifest();
