// Repairs a half-installed Electron binary. In environments that block npm
// install scripts (lavamoat allow-scripts, corporate npm, `ignore-scripts`),
// electron's postinstall never extracts its binary -- `require('electron')`
// then throws "failed to install correctly". This downloads-to-cache-and-
// extracts deterministically, bypassing the postinstall gate. Cross-platform.
//
// Run it via `npm run setup` after `npm install`.

const { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const version = require(path.join(electronDir, 'package.json')).version;
const distDir = path.join(electronDir, 'dist');

// Relative-to-dist binary path per platform (what electron/path.txt stores).
function relBinary() {
  if (process.platform === 'win32') return 'electron.exe';
  if (process.platform === 'darwin') return 'Electron.app/Contents/MacOS/Electron';
  return 'electron';
}

function alreadyInstalled() {
  const pathFile = path.join(electronDir, 'path.txt');
  if (!existsSync(pathFile)) return false;
  const rel = readFileSync(pathFile, 'utf8').trim();
  return existsSync(path.join(distDir, rel));
}

// @electron/get's default cache dir per platform.
function cacheDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'electron');
  if (process.platform === 'win32')
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron', 'Cache');
  return path.join(os.homedir(), '.cache', 'electron');
}

function findCachedZip() {
  const arch = process.arch;
  const plat = process.platform === 'win32' ? 'win32' : process.platform;
  const name = `electron-v${version}-${plat}-${arch}.zip`;
  const base = cacheDir();
  if (!existsSync(base)) return null;
  // The cache nests each artifact under a hash dir; walk one level.
  const { readdirSync } = require('node:fs');
  for (const entry of readdirSync(base)) {
    const candidate = path.join(base, entry, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function extract(zip) {
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });
  // System extractors handle the macOS framework symlinks that electron's
  // bundled extract-zip has proven flaky on here.
  let r;
  if (process.platform === 'win32') {
    r = spawnSync('tar', ['-xf', zip, '-C', distDir], { stdio: 'inherit' }); // bsdtar ships on Win10+
  } else {
    r = spawnSync('unzip', ['-q', zip, '-d', distDir], { stdio: 'inherit' });
  }
  if (r.status !== 0) throw new Error('extraction failed (is unzip/tar available?)');
  writeFileSync(path.join(electronDir, 'path.txt'), relBinary());
}

function main() {
  if (alreadyInstalled()) {
    console.log('[ensure-electron] already installed, nothing to do');
    return;
  }
  const zip = findCachedZip();
  if (!zip) {
    console.error(
      `[ensure-electron] no cached electron-v${version} zip found. First run ` +
        `"node node_modules/electron/install.js" (downloads to cache), then re-run this.`
    );
    process.exit(1);
  }
  console.log(`[ensure-electron] extracting ${path.basename(zip)}`);
  extract(zip);
  console.log('[ensure-electron] done');
}

main();
