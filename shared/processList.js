// Pure parsers for process-detection output (elrs-joystick-control "running?"
// check on the GRID screen). CommonJS, Electron-free; main/elrsLauncher.js
// owns the tasklist/pgrep spawning and feeds captured text through these.

// `tasklist /FI "IMAGENAME eq <img>" /FO CSV /NH` prints one quoted CSV row
// per match, or a localized "INFO: no tasks…" sentence (not CSV) when none.
// Counting rows whose FIRST column equals the image name (case-insensitive)
// is locale-proof: the info sentence never starts with a quoted image name.
function parseTasklistCsv(text, imageName) {
    const wanted = String(imageName).toLowerCase();
    let count = 0;
    for (const line of String(text).split(/\r?\n/)) {
        const m = line.match(/^"([^"]+)"/);
        if (m && m[1].toLowerCase() === wanted) count += 1;
    }
    return count;
}

// `pgrep -f <pattern>` prints one PID per line, exit code 1 when none.
function parsePgrepOutput(text) {
    return String(text)
        .split(/\r?\n/)
        .filter((l) => /^\d+$/.test(l.trim())).length;
}

// The image name tasklist filters on: the executable's basename. Handles both
// slash styles (a Windows path typed into settings on any dev platform).
function imageNameFromPath(p) {
    const base = String(p).split(/[\\/]/).filter(Boolean).pop() || '';
    return base;
}

module.exports = { parseTasklistCsv, parsePgrepOutput, imageNameFromPath };
