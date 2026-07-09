// Generic "last remote sender address" store for the setup flow's iPhone-IP
// suggestion. Deliberately transport-metadata ONLY: it holds one address
// string and a timestamp — no packet contents, no orientation, no sequence,
// nothing derived from what a sender said. main.js is the only place that
// connects a producer to it; the setup UI reads it as a pre-fill suggestion
// the user must still confirm. (test/noControlPath.test.js pins the
// no-payload property structurally.)

function createRemoteAddrHint(clock = () => Date.now()) {
    let addr = null;
    let atMs = 0;
    return {
        note(a) {
            if (typeof a !== 'string' || a.length === 0 || a.length > 45) return;
            addr = a;
            atMs = clock();
        },
        get() {
            if (addr === null) return null;
            return { addr, ageMs: Math.max(0, clock() - atMs) };
        },
    };
}

module.exports = { createRemoteAddrHint };
