import { describe, it, expect } from 'vitest';
import {
  buildTelemetrySnapshot,
  DRIVE_MODE_ENUM,
  CAMERA_FULL_DEFLECTION_DEG,
} from '../shared/telemetrySnapshot.js';

// Packet shape per docs/windows_bridge_contract.md (the iPhone app's canonical
// contract): snake_case fields, drive_mode enum strings, unknown fields OMITTED
// (never faked as 0/null), stale sources flagged via stale_data_warnings.

const FULL_TELEM = {
  speedKmh: 12.4, batteryV: 7.6, batteryPct: 70, linkQualityPct: 92,
  rssiDbm: -62, snrDb: 18, gear: 3, ersPct: 55, driveMode: 2,
};
const MIRROR = {
  throttle: 0.43, brake: 0.0, steering: -0.15,
  camPan: -0.5, camTilt: 0.25, videoPlaying: true,
};

describe('buildTelemetrySnapshot — golden live packet (iPhone contract §2)', () => {
  it('full live snapshot uses snake_case and the contract values', () => {
    const pkt = buildTelemetrySnapshot({
      tMs: 12345678, telem: FULL_TELEM, linkState: 'live', mirror: MIRROR,
    });
    expect(pkt).toEqual({
      protocol_version: 1,
      timestamp_ms: 12345678,
      battery_v: 7.6,
      link_quality: 92,
      rssi_dbm: -62,
      snr_db: 18,
      speed_kmh: 12.4,
      gear: 3,
      drive_mode: 'GEARBOX_ERS',
      ers_percent: 55,
      link_state: 'connected',
      throttle: 0.43,
      brake: 0.0,
      steering: -0.15,
      camera_yaw_deg: -0.5 * CAMERA_FULL_DEFLECTION_DEG,   // -45
      camera_pitch_deg: -0.25 * CAMERA_FULL_DEFLECTION_DEG, // stick down -> look down
      head_tracking_mode: 'DS4',
      video_lock: true,
    });
  });

  it('camelCase / old-draft fields are never present', () => {
    const pkt = buildTelemetrySnapshot({
      tMs: 1, telem: FULL_TELEM, linkState: 'live', mirror: MIRROR,
    });
    for (const old of ['v', 'type', 'seq', 'tMs', 'speedKmh', 'batteryV', 'linkQualityPct', 'ersPct', 'linkState']) {
      expect(pkt).not.toHaveProperty(old);
    }
  });
});

describe('drive_mode enum mapping (contract field table)', () => {
  it('maps firmware numbers to contract strings', () => {
    expect(DRIVE_MODE_ENUM).toEqual(['TRAINING', 'GEARBOX', 'GEARBOX_ERS']);
    for (const [num, str] of [[0, 'TRAINING'], [1, 'GEARBOX'], [2, 'GEARBOX_ERS']]) {
      const pkt = buildTelemetrySnapshot({
        tMs: 1, telem: { driveMode: num }, linkState: 'live', mirror: null,
      });
      expect(pkt.drive_mode).toBe(str);
    }
  });

  it('unavailable driveMode -> "UNKNOWN" (contract: use UNKNOWN when unavailable)', () => {
    const pkt = buildTelemetrySnapshot({
      tMs: 1, telem: { batteryV: 8.0 }, linkState: 'live', mirror: null,
    });
    expect(pkt.drive_mode).toBe('UNKNOWN');
  });
});

describe('unknown/omission behavior (contract "Nullable And Unknown Values")', () => {
  it('unavailable fields are OMITTED, never 0 or null', () => {
    const pkt = buildTelemetrySnapshot({
      tMs: 1, telem: { batteryV: 7.9 }, linkState: 'live', mirror: null,
    });
    expect(pkt.battery_v).toBe(7.9);
    for (const k of ['speed_kmh', 'link_quality', 'rssi_dbm', 'snr_db', 'gear', 'ers_percent',
      'throttle', 'brake', 'steering', 'camera_yaw_deg', 'camera_pitch_deg',
      'head_tracking_mode', 'video_lock']) {
      expect(pkt, `${k} must be omitted`).not.toHaveProperty(k);
    }
  });

  it('never-live source ("sim") sends no car fields at all', () => {
    const pkt = buildTelemetrySnapshot({ tMs: 1, telem: null, linkState: 'sim', mirror: null });
    expect(pkt).toEqual({ protocol_version: 1, timestamp_ms: 1 });
  });

  it('non-finite numbers are omitted, not sent', () => {
    const pkt = buildTelemetrySnapshot({
      tMs: 1, telem: { speedKmh: NaN, batteryV: Infinity, linkQualityPct: 50 },
      linkState: 'live', mirror: null,
    });
    expect(pkt).not.toHaveProperty('speed_kmh');
    expect(pkt).not.toHaveProperty('battery_v');
    expect(pkt.link_quality).toBe(50);
  });

  it('real zeros are preserved (0 is data, not unknown)', () => {
    const pkt = buildTelemetrySnapshot({
      tMs: 1, telem: { speedKmh: 0, linkQualityPct: 0, ersPct: 0 },
      linkState: 'link-lost', mirror: null,
    });
    expect(pkt.speed_kmh).toBe(0);
    expect(pkt.link_quality).toBe(0);
    expect(pkt.ers_percent).toBe(0);
  });
});

describe('stale_data_warnings behavior (contract: never re-send stale as fresh)', () => {
  it('telemetry-lost omits ALL car fields and flags stale_data_warnings', () => {
    // telem still holds the last values (as the HUD does), but the source is
    // silent: the packet must not carry them.
    const pkt = buildTelemetrySnapshot({
      tMs: 1, telem: FULL_TELEM, linkState: 'telemetry-lost', mirror: MIRROR,
    });
    expect(pkt.stale_data_warnings).toEqual(['telemetry']);
    expect(pkt.link_state).toBe('disconnected');
    for (const k of ['battery_v', 'link_quality', 'rssi_dbm', 'snr_db', 'speed_kmh', 'gear', 'drive_mode', 'ers_percent']) {
      expect(pkt, `${k} must not be re-sent as fresh`).not.toHaveProperty(k);
    }
    // The mirror is local (still fresh) and stays present.
    expect(pkt.throttle).toBe(0.43);
  });

  it('link-lost is FRESH data: LQ 0 is sent, warning set, no stale flags', () => {
    const pkt = buildTelemetrySnapshot({
      tMs: 1, telem: { ...FULL_TELEM, linkQualityPct: 0 }, linkState: 'link-lost', mirror: null,
    });
    expect(pkt.link_quality).toBe(0);
    expect(pkt.warning).toBe('LINK LOST');
    expect(pkt.link_state).toBe('degraded');
    expect(pkt).not.toHaveProperty('stale_data_warnings');
  });

  it('live packets carry no warning and no stale flags', () => {
    const pkt = buildTelemetrySnapshot({ tMs: 1, telem: FULL_TELEM, linkState: 'live', mirror: null });
    expect(pkt).not.toHaveProperty('warning');
    expect(pkt).not.toHaveProperty('stale_data_warnings');
  });
});

describe('read-only command mirror (display values only)', () => {
  it('a stale/absent mirror omits all mirror fields (caller passes null)', () => {
    const pkt = buildTelemetrySnapshot({ tMs: 1, telem: FULL_TELEM, linkState: 'live', mirror: null });
    for (const k of ['throttle', 'brake', 'steering', 'camera_yaw_deg', 'camera_pitch_deg', 'head_tracking_mode', 'video_lock']) {
      expect(pkt).not.toHaveProperty(k);
    }
  });

  it('camera degrees: stick up (negative camTilt) = positive pitch (look up)', () => {
    const pkt = buildTelemetrySnapshot({
      tMs: 1, telem: null, linkState: 'sim',
      mirror: { camPan: 1, camTilt: -1 },
    });
    expect(pkt.camera_yaw_deg).toBe(CAMERA_FULL_DEFLECTION_DEG);
    expect(pkt.camera_pitch_deg).toBe(CAMERA_FULL_DEFLECTION_DEG);
    expect(pkt.head_tracking_mode).toBe('DS4'); // no head tracking on Windows yet
  });
});

describe('honesty rules (contract "Authority And Scope")', () => {
  it('demo-only armed/failsafe are NEVER present, even if set on telem', () => {
    const pkt = buildTelemetrySnapshot({
      tMs: 1, telem: { armed: true, failsafe: true, batteryV: 8.0 }, linkState: 'live', mirror: null,
    });
    expect(pkt).not.toHaveProperty('armed');
    expect(pkt).not.toHaveProperty('failsafe');
  });

  it('no raw-CRSF / unexpected keys leak: whitelist only', () => {
    const pkt = buildTelemetrySnapshot({
      tMs: 1,
      telem: { ...FULL_TELEM, channels: [1, 2, 3], rawFrame: 'xx' },
      linkState: 'live',
      mirror: { ...MIRROR, extra: 'nope' },
      mode: 'demo',
    });
    const allowed = [
      'protocol_version', 'timestamp_ms', 'battery_v', 'link_quality', 'rssi_dbm', 'snr_db',
      'speed_kmh', 'gear', 'drive_mode', 'ers_percent', 'throttle', 'brake', 'steering',
      'camera_yaw_deg', 'camera_pitch_deg', 'head_tracking_mode', 'video_lock',
      'warning', 'stale_data_warnings', 'link_state', 'mode',
    ];
    for (const k of Object.keys(pkt)) expect(allowed, `unexpected key ${k}`).toContain(k);
  });

  it('mode is emitted only for the known diagnostic values', () => {
    expect(buildTelemetrySnapshot({ tMs: 1, telem: null, linkState: 'sim', mirror: null, mode: 'demo' }).mode).toBe('demo');
    expect(buildTelemetrySnapshot({ tMs: 1, telem: null, linkState: 'sim', mirror: null, mode: 'weird' })).not.toHaveProperty('mode');
  });
});
