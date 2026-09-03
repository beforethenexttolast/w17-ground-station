// The child-environment scrub shared by every process this viewer spawns.
//
// WHY THIS IS SHARED (review boundaries-4): the mapper reads its own
// experimental defaults from W17_* environment variables, so a child that
// inherits this app's environment verbatim would start with features the
// race-day argv whitelist deliberately never passes — an env-shaped bypass of
// that whitelist. The scrub used to live as a private method on
// main/mapperRunner.js, which left the GRID convenience LAUNCH
// (main/elrsLauncher.js) spawning the SAME program with the un-scrubbed
// environment; race day then adopts that instance as ok/'external'. One helper,
// used at every spawn site, closes that.
//
// WHY CASE-INSENSITIVE (review boundaries-5): the gift target is Windows, where
// environment-variable names are case-INSENSITIVE — `set w17_headtrack_ingest=1`
// and `W17_HEADTRACK_INGEST=1` are the same variable to a Windows child, and Go's
// os.LookupEnv on Windows resolves either. A case-SENSITIVE prefix test therefore
// let a mixed-case spelling ride straight through. The scrub is by CLASS and by
// uppercased prefix, so neither a new W17_* knob nor a novel spelling of an old
// one can silently reopen the hole.
//
// This module is deliberately tiny and dependency-free: it takes an env-shaped
// object and returns a NEW one. It never reads process.env itself, never spawns,
// and never logs — the callers own all of that.

'use strict';

const SCRUBBED_PREFIX = 'W17_';

// A copy of `env` with the ENTIRE W17_* namespace removed, matched
// case-insensitively. Non-W17 variables (PATH, HOME, SystemRoot, …) pass
// through untouched — the child still needs a working environment to run.
function scrubW17Env(env = {}) {
    const out = {};
    for (const [k, v] of Object.entries(env)) {
        if (String(k).toUpperCase().startsWith(SCRUBBED_PREFIX)) continue;
        out[k] = v;
    }
    return out;
}

module.exports = { scrubW17Env, SCRUBBED_PREFIX };
