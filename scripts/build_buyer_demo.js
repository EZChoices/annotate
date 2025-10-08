#!/usr/bin/env node

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { parseArgs } = require('util');

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const reason = code !== null ? `exit code ${code}` : `signal ${signal}`;
      reject(new Error(`Command failed (${reason}): ${command} ${args.join(' ')}`));
    });
  });
}

async function writeReadme(datasetRoot, minF1) {
  const readmePath = path.join(datasetRoot, 'README.txt');
  const summary = [
    'Dialect Data curates high-quality, rights-cleared dialect speech corpora to accelerate inclusive voice AI while meeting rigorous quality assurance and compliance standards. Each evaluation set is reviewed, privacy-safeguarded, and distributed with transparent metadata so teams can assess coverage and risk with confidence.',
    `This buyer demo showcases approximately 30–60 minutes of redacted clips that meet a minimum F1 score of ${minF1.toFixed(2)}. To explore the sample, unzip this archive and load it in the hosted Dialect Data read-only viewer, which lets prospective buyers browse audio, transcripts, and metadata without modifying the source files.`,
  ].join('\n\n');
  await fsp.writeFile(readmePath, summary, 'utf8');
}

async function main() {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      output: { type: 'string', short: 'o' },
      minF1: { type: 'string', default: '0.85' },
      source: { type: 'string' },
    },
  });

  const version = values.version;
  if (!version) {
    console.error('Error: --version is required.');
    process.exit(1);
  }

  const output = values.output;
  if (!output) {
    console.error('Error: --output is required.');
    process.exit(1);
  }

  const minF1 = Number(values.minF1 ?? '0.85');
  if (Number.isNaN(minF1) || minF1 <= 0 || minF1 > 1) {
    console.error('Error: --minF1 must be a number between 0 and 1.');
    process.exit(1);
  }

  const sourceDir = values.source ? path.resolve(values.source) : undefined;
  const resolvedOutput = path.resolve(output);

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'buyer-demo-'));
  const exportOutDir = path.join(tempRoot, 'export');
  await fsp.mkdir(exportOutDir, { recursive: true });

  const exportScript = path.join(__dirname, 'export_dataset.js');
  const exportArgs = [
    exportScript,
    '--version',
    version,
    '--out',
    exportOutDir,
    '--public',
    '--minF1',
    String(minF1),
  ];
  if (sourceDir) {
    exportArgs.push('--source', sourceDir);
  }

  try {
    await runCommand(process.execPath, exportArgs, { stdio: 'inherit' });
  } catch (err) {
    console.error('Dataset export failed:', err.message);
    await fsp.rm(tempRoot, { recursive: true, force: true });
    process.exit(1);
  }

  const datasetFolderName = `${version}-public`;
  const datasetRoot = path.join(exportOutDir, datasetFolderName);
  if (!fs.existsSync(datasetRoot)) {
    console.error(`Error: Expected dataset folder not found at ${datasetRoot}`);
    await fsp.rm(tempRoot, { recursive: true, force: true });
    process.exit(1);
  }

  try {
    await writeReadme(datasetRoot, minF1);
  } catch (err) {
    console.error('Failed to write README.txt:', err.message);
    await fsp.rm(tempRoot, { recursive: true, force: true });
    process.exit(1);
  }

  try {
    await fsp.mkdir(path.dirname(resolvedOutput), { recursive: true });
    const zipArgs = ['-r', resolvedOutput, datasetFolderName];
    await runCommand('zip', zipArgs, { cwd: exportOutDir, stdio: 'inherit' });
  } catch (err) {
    console.error('Failed to package buyer demo:', err.message);
    await fsp.rm(tempRoot, { recursive: true, force: true });
    process.exit(1);
  }

  await fsp.rm(tempRoot, { recursive: true, force: true });
  console.log(`Buyer demo ZIP created at: ${resolvedOutput}`);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
