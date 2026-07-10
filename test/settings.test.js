import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// Settings modules are CommonJS (main-process side); load via require from ESM.
const require = createRequire(import.meta.url);
const {
  DEFAULT_SETTINGS,
  normalizeSettings,
  resolveEffective,
} = require('../shared/settings.js');
const { createSettingsStore } = require('../main/settingsStore.js');

describe('normalizeSettings — garbage-safe, field-by-field', () => {
  it('null/garbage input returns full defaults (radio sounds off, W3 off, solo)', () => {
    for (const raw of [null, undefined, 42, 'x', []]) {
      const s = normalizeSettings(raw);
      expect(s).toEqual(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
      expect(s.soundEnabled).toBe(false);
      expect(s.w3DiagnosticEnabled).toBe(false);
      expect(s.fpvMode).toBe('solo');
    }
  });

  it('one corrupt field falls back alone — the rest survive', () => {
    const s = normalizeSettings({
      fpvMode: 'warp-drive', // invalid enum
      iphoneAddr: '192.168.4.2',
      controller: { id: 'DualSense (Vendor: 054c)', preset: 'nope' },
      network: { kind: 'hotspot', hotspot: { ssid: '', password: 'secret' } },
      iphonePort: 99999999, // out of range
    });
    expect(s.fpvMode).toBe('solo');
    expect(s.iphoneAddr).toBe('192.168.4.2');
    expect(s.controller.id).toBe('DualSense (Vendor: 054c)');
    expect(s.controller.preset).toBe('dualshock');
    expect(s.network.kind).toBe('hotspot');
    expect(s.network.hotspot.ssid).toBe('W17-GRID'); // empty SSID -> themed default
    expect(s.network.hotspot.password).toBe('secret');
    expect(s.iphonePort).toBe(5601);
  });

  it('unknown keys are dropped', () => {
    expect(normalizeSettings({ evilExtra: true })).not.toHaveProperty('evilExtra');
  });

  it('start lights default ON; only a boolean false disables them', () => {
    expect(normalizeSettings(null).startLightsEnabled).toBe(true);
    expect(normalizeSettings({ startLightsEnabled: false }).startLightsEnabled).toBe(false);
    expect(normalizeSettings({ startLightsEnabled: 'no' }).startLightsEnabled).toBe(true);
  });

  it('network.adapter is a plain string, defaulting to "" (system default)', () => {
    expect(normalizeSettings(null).network.adapter).toBe('');
    expect(normalizeSettings({ network: { adapter: 'Wi-Fi 2' } }).network.adapter).toBe('Wi-Fi 2');
    expect(normalizeSettings({ network: { adapter: 42 } }).network.adapter).toBe('');
  });
});

describe('resolveEffective — env always beats settings, unset falls through', () => {
  const iphoneSettings = {
    fpvMode: 'iphone-hud',
    iphoneAddr: '192.168.4.2',
    iphonePort: 5601,
    telemetry: { source: 'replay', port: '' },
    w3DiagnosticEnabled: true,
  };

  it('no env + defaults: nothing enabled (bit-identical to the pre-settings app)', () => {
    const e = resolveEffective(null, {});
    expect(e.telemetry).toEqual({ source: 'none', port: '' });
    expect(e.iphoneBridge).toBeNull();
    expect(e.w3Wish).toEqual({ fromEnv: false, enabled: false });
    expect(e.envOverridden).toEqual({
      telemetrySource: false, telemetryPort: false, iphoneBridge: false, w3: false,
    });
  });

  it('settings alone can enable everything (iphone-hud mode)', () => {
    const e = resolveEffective(iphoneSettings, {});
    expect(e.telemetry.source).toBe('replay');
    expect(e.iphoneBridge).toEqual({ addr: '192.168.4.2', port: 5601, rateHz: 10 });
    expect(e.w3Wish).toEqual({ fromEnv: false, enabled: true });
  });

  it('iphone-hud without an address keeps the bridge off (no half-config)', () => {
    const e = resolveEffective({ ...iphoneSettings, iphoneAddr: '' }, {});
    expect(e.iphoneBridge).toBeNull();
  });

  it('solo mode never enables the bridge even with an address saved', () => {
    const e = resolveEffective({ ...iphoneSettings, fpvMode: 'solo' }, {});
    expect(e.iphoneBridge).toBeNull();
  });

  it('W17_IPHONE_BRIDGE set to 0 force-disables a settings-enabled bridge', () => {
    const e = resolveEffective(iphoneSettings, { W17_IPHONE_BRIDGE: '0' });
    expect(e.iphoneBridge).toBeNull();
    expect(e.envOverridden.iphoneBridge).toBe(true);
  });

  it('env bridge config wins wholesale over settings', () => {
    const e = resolveEffective(iphoneSettings, {
      W17_IPHONE_BRIDGE: '1', W17_IPHONE_ADDR: '10.0.0.9', W17_IPHONE_PORT: '50000',
    });
    expect(e.iphoneBridge).toEqual({ addr: '10.0.0.9', port: 50000, rateHz: 10 });
  });

  it('sub-key env vars override a settings-enabled bridge (port/rate)', () => {
    const e = resolveEffective(iphoneSettings, { W17_IPHONE_RATE_HZ: '20' });
    expect(e.iphoneBridge).toEqual({ addr: '192.168.4.2', port: 5601, rateHz: 20 });
  });

  it('telemetry source/port: env set wins, unset falls through', () => {
    const env = { W17_TELEMETRY_SOURCE: 'crsf-serial', W17_TELEMETRY_PORT: 'COM7' };
    expect(resolveEffective(iphoneSettings, env).telemetry)
      .toEqual({ source: 'crsf-serial', port: 'COM7' });
    expect(resolveEffective(iphoneSettings, {}).telemetry.source).toBe('replay');
    expect(resolveEffective(iphoneSettings, env).envOverridden.telemetrySource).toBe(true);
  });

  it('W17_HEADTRACK presence flags env override of the W3 wish (even =0)', () => {
    expect(resolveEffective(iphoneSettings, { W17_HEADTRACK: '0' }).envOverridden.w3).toBe(true);
    expect(resolveEffective(iphoneSettings, { W17_HEADTRACK: '0' }).w3Wish.fromEnv).toBe(true);
    expect(resolveEffective(iphoneSettings, {}).w3Wish).toEqual({ fromEnv: false, enabled: true });
  });

  it('half-configured env bridge warns (delegates to the existing resolver)', () => {
    const warn = vi.fn();
    resolveEffective(null, { W17_IPHONE_BRIDGE: '1' }, warn);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('settingsStore — atomic, corruption-proof persistence', () => {
  const freshDir = () => mkdtempSync(join(tmpdir(), 'w17-settings-'));

  it('load() on a missing file returns defaults without creating anything', () => {
    const dir = freshDir();
    const store = createSettingsStore({ dir });
    expect(store.load()).toEqual(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
    expect(existsSync(store.file)).toBe(false);
  });

  it('save() round-trips through normalize and load() reads it back', () => {
    const store = createSettingsStore({ dir: freshDir() });
    const saved = store.save({ fpvMode: 'iphone-hud', iphoneAddr: '192.168.4.2' });
    expect(saved.fpvMode).toBe('iphone-hud');
    expect(store.load().iphoneAddr).toBe('192.168.4.2');
  });

  it('save() patches nested objects one level deep without clobbering siblings', () => {
    const store = createSettingsStore({ dir: freshDir() });
    store.save({ network: { kind: 'hotspot', hotspot: { password: 'pw123' } } });
    store.save({ network: { ssid: 'PaddockNet' } });
    const s = store.load();
    expect(s.network.kind).toBe('hotspot');
    expect(s.network.ssid).toBe('PaddockNet');
    expect(s.network.hotspot).toEqual({ ssid: 'W17-GRID', password: 'pw123' });
  });

  it('corrupt JSON on disk degrades to defaults and logs, never throws', () => {
    const dir = freshDir();
    const log = vi.fn();
    const store = createSettingsStore({ dir, log });
    writeFileSync(store.file, '{ not json', 'utf8');
    expect(store.load()).toEqual(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
    expect(log).toHaveBeenCalledOnce();
  });

  it('every rewrite keeps the previous file as .bak', () => {
    const store = createSettingsStore({ dir: freshDir() });
    store.save({ fpvMode: 'iphone-hud' });
    store.save({ fpvMode: 'solo' });
    const bak = JSON.parse(readFileSync(`${store.file}.bak`, 'utf8'));
    expect(bak.fpvMode).toBe('iphone-hud');
    expect(store.load().fpvMode).toBe('solo');
  });
});
