#!/usr/bin/env node

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { parseArgs } = require('util');

function execAsync(command, options = {}) {
  return new Promise((resolve, reject) => {
    exec(command, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function shellEscape(value) {
  if (value === undefined || value === null) {
    return '';
  }
  if (/^[A-Za-z0-9_\-\.\/]+$/.test(value)) {
    return value;
  }
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function createVersionLabel() {
  const iso = new Date().toISOString().replace(/[\.:]/g, '-');
  return `buyer-demo-${iso}`;
}

async function ensureZipBinary() {
  try {
    await execAsync('zip -v');
  } catch (err) {
    throw new Error('The "zip" utility is required but was not found on this system.');
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      output: { type: 'string' },
      minF1: { type: 'string', default: '0.85' },
    },
  });

  const outputPathRaw = values.output;
  if (!outputPathRaw) {
    console.error('Error: --output <zip_path> is required.');
    process.exit(1);
  }
  const outputPath = path.resolve(outputPathRaw);

  const minF1Raw = values.minF1 ?? '0.85';
  const minF1 = Number(minF1Raw);
  if (Number.isNaN(minF1)) {
    console.error('Error: --minF1 must be a numeric value.');
    process.exit(1);
  }

  const inputDir = values.input ? path.resolve(values.input) : undefined;

  await ensureZipBinary();

  let tmpRoot;
  try {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'buyer-demo-'));
    const versionLabel = createVersionLabel();
    const exportScript = path.join(__dirname, 'export_dataset.js');

    const exportArgs = [
      'node',
      exportScript,
      '--version',
      versionLabel,
      '--out',
      tmpRoot,
      '--public',
      '--minF1',
      String(minF1Raw),
    ];

    if (inputDir) {
      exportArgs.push('--source', inputDir);
    }

    const command = exportArgs.map(shellEscape).join(' ');
    const { stdout: exportStdout, stderr: exportStderr } = await execAsync(command, {
      cwd: path.resolve(__dirname, '..'),
      maxBuffer: 1024 * 1024 * 20,
    });
    if (exportStdout) {
      process.stdout.write(exportStdout);
    }
    if (exportStderr) {
      process.stderr.write(exportStderr);
    }

    const datasetDir = path.join(tmpRoot, `${versionLabel}-public`);
    try {
      await fsp.access(datasetDir, fs.constants.R_OK);
    } catch (err) {
      throw new Error(`Failed to locate exported dataset at expected path: ${datasetDir}`);
    }

    const readmePath = path.join(datasetDir, 'README.txt');
    const readmeContent = [
      'Dialect Data curates speech collections that balance linguistic diversity, audio quality, and thorough review. Each release is benchmarked for coverage, backed by traceable provenance, and validated to meet compliance and privacy commitments.',
      `This buyer demo contains roughly 30–60 minutes of anonymized clips that meet an F1 score of at least ${minF1.toFixed(2)}. All samples are redacted for privacy and can be explored with the read-only evaluation viewer to preview the Dialect Data experience.`,
    ].join('\n\n');
    await fsp.writeFile(readmePath, readmeContent, 'utf8');

    await fsp.mkdir(path.dirname(outputPath), { recursive: true });

    const zipCommand = ['zip', '-r', shellEscape(outputPath), '.'].join(' ');
    const { stdout: zipStdout, stderr: zipStderr } = await execAsync(zipCommand, {
      cwd: datasetDir,
      maxBuffer: 1024 * 1024 * 20,
    });
    if (zipStdout) {
      process.stdout.write(zipStdout);
    }
    if (zipStderr) {
      process.stderr.write(zipStderr);
    }

    console.log(`Buyer demo pack created at: ${outputPath}`);
  } finally {
    if (tmpRoot) {
      await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
