const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

async function copyDir(src, dest) {
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  await fs.promises.mkdir(dest, { recursive: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.promises.copyFile(srcPath, destPath);
    }
  }
}

async function setupFixture(name) {
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nightly-irr-'));
  const stage2Dir = path.join(tmpRoot, 'stage2_output');
  const irrDir = path.join(tmpRoot, 'irr');
  await copyDir(path.join(__dirname, 'fixtures/nightly_irr', name, 'stage2_output'), stage2Dir);
  await fs.promises.mkdir(irrDir, { recursive: true });
  return { tmpRoot, stage2Dir, irrDir };
}

function loadIrrModule() {
  delete require.cache[require.resolve('../scripts/nightly_irr.js')];
  return require('../scripts/nightly_irr.js');
}

async function teardown(tmpRoot) {
  await fs.promises.rm(tmpRoot, { recursive: true, force: true });
}

test('voice tag alpha is near 1 for perfect agreement', { concurrency: false }, async (t) => {
  const { tmpRoot, stage2Dir, irrDir } = await setupFixture('perfect');
  process.env.STAGE2_OUTPUT_DIR = stage2Dir;
  process.env.IRR_OUTPUT_DIR = irrDir;
  const irr = loadIrrModule();
  const metricsData = await irr.loadAssetMetrics();
  const voiceSummary = irr.buildAlphaSummary(metricsData.voiceTagItems);
  assert.ok(voiceSummary);
  assert.equal(voiceSummary.nItemsGlobal, 2);
  assert.ok(voiceSummary.alphaGlobal != null);
  assert(Math.abs(voiceSummary.alphaGlobal - 1) < 1e-9);
  await teardown(tmpRoot);
  delete process.env.STAGE2_OUTPUT_DIR;
  delete process.env.IRR_OUTPUT_DIR;
});

test('voice tag alpha is near 0 for mixed agreement', { concurrency: false }, async (t) => {
  const { tmpRoot, stage2Dir, irrDir } = await setupFixture('half_disagreement');
  process.env.STAGE2_OUTPUT_DIR = stage2Dir;
  process.env.IRR_OUTPUT_DIR = irrDir;
  const irr = loadIrrModule();
  const metricsData = await irr.loadAssetMetrics();
  const voiceSummary = irr.buildAlphaSummary(metricsData.voiceTagItems);
  assert.ok(voiceSummary);
  assert.equal(voiceSummary.nItemsGlobal, 4);
  assert.ok(voiceSummary.alphaGlobal != null);
  assert(Math.abs(voiceSummary.alphaGlobal) < 0.2);
  await teardown(tmpRoot);
  delete process.env.STAGE2_OUTPUT_DIR;
  delete process.env.IRR_OUTPUT_DIR;
});
