// Team-radio sound cues, synthesized with WebAudio — no bundled assets, no
// network, CSP-clean. OFF by default (settings toggle `soundEnabled`); every
// cue no-ops while disabled. The AudioContext is created lazily on the first
// enabled cue, which always follows a user click, satisfying Chromium's
// autoplay gesture policy.

let enabled = false;
let ctx = null;

export function setSoundEnabled(v) { enabled = !!v; }

function audioCtx() {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// One tone with a fast envelope; `type` square/sine for radio vs gantry.
function tone(freq, durMs, { type = 'square', gain = 0.06, delayMs = 0 } = {}) {
  const ac = audioCtx();
  const t0 = ac.currentTime + delayMs / 1000;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
  osc.connect(g).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + durMs / 1000 + 0.02);
}

// Short white-noise burst — the radio-key "click".
function click(durMs, { gain = 0.05, delayMs = 0 } = {}) {
  const ac = audioCtx();
  const t0 = ac.currentTime + delayMs / 1000;
  const len = Math.max(1, Math.floor(ac.sampleRate * (durMs / 1000)));
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ac.createBufferSource();
  const g = ac.createGain();
  g.gain.value = gain;
  src.buffer = buf;
  src.connect(g).connect(ac.destination);
  src.start(t0);
}

export const sounds = {
  radioOpen() { if (!enabled) return; click(30); tone(1250, 45, { delayMs: 28, gain: 0.04 }); },
  radioClose() { if (!enabled) return; tone(950, 40, { gain: 0.035 }); click(25, { delayMs: 30 }); },
  uiTick() { if (!enabled) return; tone(1600, 30, { gain: 0.03 }); },
  lightOn() { if (!enabled) return; tone(880, 90, { type: 'sine', gain: 0.07 }); },
  lightsOut() { if (!enabled) return; tone(660, 60, { type: 'sine', gain: 0.05 }); tone(1320, 240, { type: 'sine', gain: 0.08, delayMs: 70 }); },
};
