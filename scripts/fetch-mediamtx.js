// Downloads a pinned mediamtx binary for the host platform into mediamtx/.
// The binary is NOT committed (it's in .gitignore); run `npm run fetch-mediamtx`
// (or `npm run setup`) after cloning. CommonJS.
//
// Pin the version so mediamtx.yml's config keys stay valid across releases.

const { mkdirSync, existsSync, createWriteStream, chmodSync } = require('node:fs');
const { rm } = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MEDIAMTX_VERSION = 'v1.9.3'; // PIN: verify WHEP config keys match this release
const outDir = path.join(__dirname, '..', 'mediamtx');

function assetName() {
  const p = process.platform;
  const a = process.arch;
  const osName = p === 'win32' ? 'windows' : p === 'darwin' ? 'darwin' : 'linux';
  const arch = a === 'arm64' ? 'arm64' : a === 'x64' ? 'amd64' : a;
  const ext = osName === 'windows' ? 'zip' : 'tar.gz';
  return { file: `mediamtx_${MEDIAMTX_VERSION}_${osName}_${arch}.${ext}`, osName, ext };
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const { file, osName, ext } = assetName();
  const url = `https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}/${file}`;
  const archive = path.join(outDir, file);

  console.log(`[fetch-mediamtx] ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await new Promise((resolve, reject) => {
    const ws = createWriteStream(archive);
    ws.on('error', reject);
    ws.on('finish', resolve);
    ws.end(buf);
  });

  // Extract just the binary (release archives also ship a sample yml we don't
  // use -- our mediamtx.yml is authoritative).
  if (ext === 'zip') {
    spawnSync('tar', ['-xf', archive, '-C', outDir, 'mediamtx.exe'], { stdio: 'inherit' });
  } else {
    spawnSync('tar', ['-xzf', archive, '-C', outDir, 'mediamtx'], { stdio: 'inherit' });
    const bin = path.join(outDir, 'mediamtx');
    if (existsSync(bin)) chmodSync(bin, 0o755);
  }
  await rm(archive);
  console.log(`[fetch-mediamtx] done (${osName})`);
}

main().catch((e) => {
  console.error(`[fetch-mediamtx] ${e.message}`);
  process.exit(1);
});
