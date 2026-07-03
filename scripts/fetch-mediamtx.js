// Downloads a pinned mediamtx binary for the host platform into mediamtx/.
// The binary is NOT committed (it's in .gitignore); run `npm run fetch-mediamtx`
// after cloning, and it's fetched again at package time onto the target OS.
//
// Pin the version so mediamtx.yml's config keys stay valid across releases.

import { mkdirSync, existsSync, createWriteStream, chmodSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const MEDIAMTX_VERSION = 'v1.9.3'; // PIN: verify WHEP config keys match this release
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'mediamtx');

// Map Node's platform/arch to mediamtx release asset names.
function assetName() {
  const p = process.platform, a = process.arch;
  const os = p === 'win32' ? 'windows' : p === 'darwin' ? 'darwin' : 'linux';
  const arch = a === 'arm64' ? 'arm64' : a === 'x64' ? 'amd64' : a;
  const ext = os === 'windows' ? 'zip' : 'tar.gz';
  return { file: `mediamtx_${MEDIAMTX_VERSION}_${os}_${arch}.${ext}`, os, ext };
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const { file, os, ext } = assetName();
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

  // Extract just the binary (release archives ship the binary + a sample yml
  // we don't use -- our mediamtx.yml is authoritative).
  if (ext === 'zip') {
    spawnSync('tar', ['-xf', archive, '-C', outDir, 'mediamtx.exe'], { stdio: 'inherit' });
  } else {
    spawnSync('tar', ['-xzf', archive, '-C', outDir, 'mediamtx'], { stdio: 'inherit' });
    const bin = path.join(outDir, 'mediamtx');
    if (existsSync(bin)) chmodSync(bin, 0o755);
  }
  await rm(archive);
  console.log(`[fetch-mediamtx] done (${os})`);
}

main().catch((e) => {
  console.error(`[fetch-mediamtx] ${e.message}`);
  process.exit(1);
});
