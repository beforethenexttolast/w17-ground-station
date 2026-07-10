import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseNetshNetworks,
  parseNetshInterfaces,
  parseNetshInterfacesList,
  parseNetshProfiles,
  parseNetshDrivers,
  buildWlanProfileXml,
} = require('../shared/wifiParse.js');

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('parseNetshNetworks — structure-based, locale-tolerant', () => {
  it('parses the English fixture: ssid, best signal, auth by position, bssid count', () => {
    const nets = parseNetshNetworks(fixture('netsh_networks_en.txt'));
    expect(nets).toEqual([
      { ssid: 'PaddockNet', signalPct: 87, auth: 'WPA2-Personal', bssidCount: 2 },
      { ssid: 'Cafe Guest 2.4', signalPct: 42, auth: 'Open', bssidCount: 1 },
    ]);
  });

  it('drops hidden networks (empty SSID)', () => {
    const nets = parseNetshNetworks(fixture('netsh_networks_en.txt'));
    expect(nets.some((n) => n.ssid === '')).toBe(false);
  });

  it('parses the German fixture identically (labels never matched)', () => {
    const nets = parseNetshNetworks(fixture('netsh_networks_de.txt'));
    expect(nets).toEqual([
      { ssid: 'PaddockNet', signalPct: 87, auth: 'WPA2-Personal', bssidCount: 1 },
      { ssid: 'W17-GRID', signalPct: 99, auth: 'WPA2-Personal', bssidCount: 1 },
    ]);
  });

  it('empty/garbage input parses to an empty list', () => {
    expect(parseNetshNetworks('')).toEqual([]);
    expect(parseNetshNetworks('no networks here')).toEqual([]);
  });
});

describe('parseNetshInterfaces — connectedness from the literal SSID acronym', () => {
  it('connected interface reports ssid + signal', () => {
    expect(parseNetshInterfaces(fixture('netsh_interfaces_en.txt'))).toEqual({
      connected: true,
      ssid: 'PaddockNet',
      signalPct: 90,
    });
  });

  it('disconnected output (no SSID value) reports not connected', () => {
    const out = [
      'There is 1 interface on the system:',
      '',
      '    Name                   : Wi-Fi',
      '    State                  : disconnected',
    ].join('\n');
    expect(parseNetshInterfaces(out)).toEqual({ connected: false, ssid: '', signalPct: null });
  });
});

describe('parseNetshInterfacesList — every adapter, first field = name', () => {
  it('two adapters: built-in (connected) + USB dongle (disconnected)', () => {
    expect(parseNetshInterfacesList(fixture('netsh_interfaces_two_en.txt'))).toEqual([
      {
        name: 'Wi-Fi',
        description: 'Intel(R) Wi-Fi 6 AX201 160MHz',
        connected: true,
        ssid: 'PaddockNet',
        signalPct: 90,
      },
      {
        name: 'Wi-Fi 2',
        description: 'Ralink RT5370 USB Wireless Adapter',
        connected: false,
        ssid: '',
        signalPct: null,
      },
    ]);
  });

  it('single-adapter fixture: the trailing hosted-network pseudo-block is dropped', () => {
    const list = parseNetshInterfacesList(fixture('netsh_interfaces_en.txt'));
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Wi-Fi');
    expect(list[0].connected).toBe(true);
  });

  it('empty/garbage input parses to an empty list', () => {
    expect(parseNetshInterfacesList('')).toEqual([]);
    expect(parseNetshInterfacesList('no interfaces here')).toEqual([]);
  });
});

describe('parseNetshProfiles', () => {
  it('collects profile names, skipping headers and <None>', () => {
    expect(parseNetshProfiles(fixture('netsh_profiles_en.txt')))
      .toEqual(['PaddockNet', 'Home Net 5G', 'W17-GRID']);
  });
});

describe('parseNetshDrivers — hosted-network support, null when unknowable', () => {
  it('RT5370 English fixture: supported', () => {
    expect(parseNetshDrivers(fixture('netsh_drivers_en.txt')))
      .toEqual({ hostedNetworkSupported: true });
  });

  it('German label keeps the latin "host" stem and localized yes/no', () => {
    const de = '    Unterstützte gehostete Netzwerke  : Ja\n';
    expect(parseNetshDrivers(de)).toEqual({ hostedNetworkSupported: true });
    expect(parseNetshDrivers(de.replace('Ja', 'Nein')))
      .toEqual({ hostedNetworkSupported: false });
  });

  it('unrecognizable output -> null (caller degrades gracefully, never hard-no)', () => {
    expect(parseNetshDrivers('nothing relevant')).toEqual({ hostedNetworkSupported: null });
  });
});

describe('buildWlanProfileXml — user input is XML-escaped', () => {
  it('embeds ssid and key', () => {
    const xml = buildWlanProfileXml('W17-GRID', 'lights0ut!');
    expect(xml).toContain('<name>W17-GRID</name>');
    expect(xml).toContain('<keyMaterial>lights0ut!</keyMaterial>');
    expect(xml).toContain('<authentication>WPA2PSK</authentication>');
  });

  it('escapes XML metacharacters in SSID and password (injection-proof)', () => {
    const xml = buildWlanProfileXml('Pit & "Wall" <1>', `pw'&<>"`);
    expect(xml).toContain('Pit &amp; &quot;Wall&quot; &lt;1&gt;');
    expect(xml).toContain('<keyMaterial>pw&apos;&amp;&lt;&gt;&quot;</keyMaterial>');
    // No raw metacharacters may survive: every & must open a known entity,
    // and the raw user strings must not appear verbatim.
    expect(xml.match(/&(?!amp;|quot;|apos;|lt;|gt;)/)).toBeNull();
    expect(xml).not.toContain('Pit & "Wall"');
  });
});
