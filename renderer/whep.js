// Minimal WHEP (WebRTC-HTTP Egress Protocol) client: POST an SDP offer to
// mediamtx's WHEP endpoint, apply the answer, attach the inbound video track
// to a <video>. Video-only, with per-profile player tuning (vision decision 7)
// whose DEFAULTS are the DRIVE profile — minimum latency (playoutDelayHint =
// 0, jitter buffer untouched) — and an auto-retry loop because the 5.8GHz FPV
// WiFi link drops and a dead <video> must recover on its own.
//
// Transport signals (audit C1): the client reports its connection lifecycle
// through `onStatus` — 'connecting' at each (re)connect attempt, 'dropped' when
// an established peer connection fails/disconnects, 'stopped' on teardown. The
// HUD folds these plus the <video> media events into shared/videoState.mjs so
// video_lock is confidently green ONLY while frames flow — a WebRTC drop, which
// leaves the <video> frozen on its last frame WITHOUT firing a media event, is
// reported here so the lock drops immediately instead of staying stale-green.

// The historical (pre-profile) player literals, which ARE the DRIVE profile:
// an untuned startWhep() behaves byte-for-byte like the pre-profile client.
// test/videoProfiles.test.js pins these against VIDEO_PROFILES.drive.player so
// neither side can drift. jitterBufferTargetMs null = LEAVE THE PROPERTY
// UNTOUCHED (the pre-profile client never set it; a numeric 0 would be a
// different statement to the browser).
export const WHEP_PLAYER_DEFAULTS = Object.freeze({
  playoutDelayHintS: 0,
  jitterBufferTargetMs: null,
  retryMs: 1500,
});

export function startWhep(videoEl, whepUrl, { log = () => {}, onStatus = () => {}, player = {} } = {}) {
  const tuning = { ...WHEP_PLAYER_DEFAULTS, ...player };
  let pc = null;
  let stopped = false;
  let retryTimer = null;

  async function connectOnce() {
    // Capture THIS attempt's peer connection: a stale callback from an earlier
    // attempt (after a reconnect swapped `pc`) must not report a drop for the
    // live one. `thisPc !== pc` identifies a superseded attempt.
    const thisPc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
    pc = thisPc;
    // Receive-only video; no audio track negotiated (FPV feed has none, and a
    // dead audio track just adds handshake surface + latency).
    thisPc.addTransceiver('video', { direction: 'recvonly' });

    thisPc.ontrack = (e) => {
      // Profile playout delay: DRIVE = 0 (latency over smoothness for FPV),
      // SHOWPIECE trades a deliberate buffer for a smoother picture.
      if ('playoutDelayHint' in e.receiver) {
        try {
          e.receiver.playoutDelayHint = tuning.playoutDelayHintS;
        } catch {
          /* not all builds allow setting it */
        }
      }
      // The current standard spelling of the same intent (milliseconds).
      // null = leave the browser default alone — DRIVE never touches it,
      // exactly like the pre-profile client.
      if (tuning.jitterBufferTargetMs !== null && 'jitterBufferTarget' in e.receiver) {
        try {
          e.receiver.jitterBufferTarget = tuning.jitterBufferTargetMs;
        } catch {
          /* not all builds allow setting it */
        }
      }
      videoEl.srcObject = e.streams[0];
      videoEl.play().catch(() => {});
    };

    thisPc.onconnectionstatechange = () => {
      if (thisPc !== pc || stopped) return; // superseded attempt: ignore
      const s = thisPc.connectionState;
      if (s === 'failed' || s === 'disconnected' || s === 'closed') {
        // An ESTABLISHED connection dropped: the <video> may freeze silently,
        // so signal it explicitly and reconnect.
        onStatus('dropped');
        scheduleRetry();
      }
    };

    const offer = await thisPc.createOffer();
    await thisPc.setLocalDescription(offer);

    const res = await fetch(whepUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: offer.sdp,
    });
    if (!res.ok) throw new Error(`WHEP ${res.status}`);
    const answer = await res.text();
    await thisPc.setRemoteDescription({ type: 'answer', sdp: answer });
  }

  function scheduleRetry() {
    if (stopped || retryTimer) return;
    cleanupPc();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, tuning.retryMs);
  }

  function cleanupPc() {
    if (pc) {
      try {
        pc.close();
      } catch {
        /* ignore */
      }
      pc = null;
    }
  }

  async function connect() {
    if (stopped) return;
    // Each attempt (initial + retries) is honestly "connecting" until frames
    // arrive; the media 'playing' event is what promotes the HUD to LIVE.
    onStatus('connecting');
    try {
      await connectOnce();
      log(`[video] WHEP connected: ${whepUrl}`);
    } catch (err) {
      log(`[video] WHEP connect failed (${err.message}); retrying`);
      scheduleRetry();
    }
  }

  connect();

  return {
    stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      cleanupPc();
      onStatus('stopped');
    },
  };
}
