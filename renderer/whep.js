// Minimal WHEP (WebRTC-HTTP Egress Protocol) client: POST an SDP offer to
// mediamtx's WHEP endpoint, apply the answer, attach the inbound video track
// to a <video>. Video-only, minimum latency (playoutDelayHint = 0), and an
// auto-retry loop because the 5.8GHz FPV WiFi link drops and a dead <video>
// must recover on its own.

export function startWhep(videoEl, whepUrl, { log = () => {} } = {}) {
  let pc = null;
  let stopped = false;
  let retryTimer = null;

  async function connectOnce() {
    pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
    // Receive-only video; no audio track negotiated (FPV feed has none, and a
    // dead audio track just adds handshake surface + latency).
    pc.addTransceiver('video', { direction: 'recvonly' });

    pc.ontrack = (e) => {
      // Minimum playout delay: prefer latency over smoothness for FPV.
      if ('playoutDelayHint' in e.receiver) {
        try {
          e.receiver.playoutDelayHint = 0;
        } catch {
          /* not all builds allow setting it */
        }
      }
      videoEl.srcObject = e.streams[0];
      videoEl.play().catch(() => {});
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'disconnected' || s === 'closed') scheduleRetry();
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const res = await fetch(whepUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: offer.sdp,
    });
    if (!res.ok) throw new Error(`WHEP ${res.status}`);
    const answer = await res.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
  }

  function scheduleRetry() {
    if (stopped || retryTimer) return;
    cleanupPc();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, 1500);
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
    },
  };
}
