// Persisted setup-flow settings: a single settings.json under the directory
// main.js gives us (Electron's userData in the app; a temp dir in tests).
// Thin IO in the repo style — all shape/validation logic lives in
// shared/settings.js; this file only reads, merges, and atomically writes.
//
// Robustness rules (plan "settings corruption"):
//  - Missing or unparseable file  -> normalized defaults; NEVER blocks launch.
//  - Every save writes tmp + rename (atomic on one filesystem) and keeps the
//    previous file as settings.json.bak, so one bad write can't eat the config.

const fs = require('node:fs');
const path = require('node:path');
const { normalizeSettings } = require('../shared/settings.js');

function createSettingsStore({ dir, log = () => {} }) {
    if (!dir) throw new Error('settings store requires a directory');
    const file = path.join(dir, 'settings.json');
    const bak = `${file}.bak`;
    const tmp = `${file}.tmp`;

    function load() {
        try {
            const raw = fs.readFileSync(file, 'utf8');
            return normalizeSettings(JSON.parse(raw));
        } catch (err) {
            if (err.code !== 'ENOENT') {
                log(`[settings] unreadable ${file} (${err.message}); using defaults`);
            }
            return normalizeSettings(null);
        }
    }

    // Shallow patch at the top level, with one-level merge for the nested
    // objects (network/controller/telemetry) so a UI step can update just its
    // own fields. Everything funnels through normalizeSettings before hitting
    // disk — garbage in a patch degrades field-by-field, never structurally.
    function save(patch = {}) {
        const current = load();
        const merged = { ...current, ...patch };
        for (const key of ['network', 'controller', 'telemetry']) {
            if (patch[key] && typeof patch[key] === 'object') {
                merged[key] = { ...current[key], ...patch[key] };
                if (key === 'network' && patch.network.hotspot) {
                    merged.network.hotspot = {
                        ...current.network.hotspot,
                        ...patch.network.hotspot,
                    };
                }
            }
        }
        const normalized = normalizeSettings(merged);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
        try {
            fs.copyFileSync(file, bak);
        } catch {
            /* first save: nothing to back up */
        }
        fs.renameSync(tmp, file);
        return normalized;
    }

    return { load, save, file };
}

module.exports = { createSettingsStore };
