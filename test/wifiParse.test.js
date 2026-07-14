import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseNetshNetworks,
  parseNetshInterfacesList,
  parseNetshProfiles,
  parseNetshDrivers,
  classifyWifiSecurity,
  buildWlanProfileXml,
  buildOpenWlanProfileXml,
} = require('../shared/wifiParse.js');

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('parseNetshNetworks — structure-based, locale-tolerant', () => {
  it('parses the English fixture: ssid, best signal, auth+encryption by position, security, bssid count', () => {
    const nets = parseNetshNetworks(fixture('netsh_networks_en.txt'));
    expect(nets).toEqual([
      { ssid: 'PaddockNet', signalPct: 87, auth: 'WPA2-Personal', encryption: 'CCMP', security: 'wpa2-personal', bssidCount: 2 },
      { ssid: 'Cafe Guest 2.4', signalPct: 42, auth: 'Open', encryption: 'None', security: 'open', bssidCount: 1 },
    ]);
  });

  it('drops hidden networks (empty SSID)', () => {
    const nets = parseNetshNetworks(fixture('netsh_networks_en.txt'));
    expect(nets.some((n) => n.ssid === '')).toBe(false);
  });

  it('drops whitespace-only SSIDs too (never an unnamed clickable row)', () => {
    const text = [
      'SSID 1 :    ',
      '    Network type            : Infrastructure',
      '    Authentication          : WPA2-Personal',
      '    Encryption              : CCMP',
      '    BSSID 1                 : aa:bb:cc:dd:ee:ff',
      '         Signal             : 50%',
    ].join('\n');
    expect(parseNetshNetworks(text)).toEqual([]);
  });

  it('parses the German fixture identically (labels never matched)', () => {
    const nets = parseNetshNetworks(fixture('netsh_networks_de.txt'));
    expect(nets).toEqual([
      { ssid: 'PaddockNet', signalPct: 87, auth: 'WPA2-Personal', encryption: 'CCMP', security: 'wpa2-personal', bssidCount: 1 },
      { ssid: 'W17-GRID', signalPct: 99, auth: 'WPA2-Personal', encryption: 'CCMP', security: 'wpa2-personal', bssidCount: 1 },
    ]);
  });

  it('empty/garbage input parses to an empty list', () => {
    expect(parseNetshNetworks('')).toEqual([]);
    expect(parseNetshNetworks('no networks here')).toEqual([]);
  });

  it('attaches a normalized security kind to every network (audit B3)', () => {
    const nets = parseNetshNetworks(fixture('netsh_networks_security_en.txt'));
    expect(nets.map((n) => [n.ssid, n.security])).toEqual([
      ['OpenCafe', 'open'],
      ['HomeWPA2', 'wpa2-personal'],
      ['Modern6E', 'wpa3-only'],
      ['Blend23', 'wpa2-wpa3-transition'],
      ['CorpNet', 'enterprise'],
      ['OldWEP', 'unknown'],       // WEP: "Open" auth but encrypted-legacy
    ]);
    // The empty-SSID 7th block is dropped, never surfaced.
    expect(nets.some((n) => n.ssid === '')).toBe(false);
    expect(nets).toHaveLength(6);
    // Raw auth/encryption are retained verbatim for diagnostics.
    expect(nets[0]).toMatchObject({ auth: 'Open', encryption: 'None' });
    expect(nets[3].auth).toBe('WPA2-Personal, WPA3-Personal');
  });

  it('classifies a localized (German) OPEN network from Offen/Keine', () => {
    const nets = parseNetshNetworks(fixture('netsh_networks_open_de.txt'));
    expect(nets).toEqual([
      { ssid: 'Gastnetz', signalPct: 88, auth: 'Offen', encryption: 'Keine', security: 'open', bssidCount: 1 },
    ]);
  });
});

describe('classifyWifiSecurity — normalized model from auth + encryption', () => {
  const cases = [
    [{ auth: 'Open', encryption: 'None' }, 'open'],
    [{ auth: 'Offen', encryption: 'Keine' }, 'open'],          // localized open
    [{ auth: 'Ouvert', encryption: 'Aucun' }, 'open'],
    [{ auth: '', encryption: 'None' }, 'open'],                // enc corroborates
    [{ auth: 'WPA2-Personal', encryption: 'CCMP' }, 'wpa2-personal'],
    [{ auth: 'WPA2-Personal, WPA3-Personal', encryption: 'CCMP' }, 'wpa2-wpa3-transition'],
    [{ auth: 'WPA3-Personal', encryption: 'GCMP' }, 'wpa3-only'],
    [{ auth: 'WPA2-Enterprise', encryption: 'CCMP' }, 'enterprise'],
    [{ auth: 'WPA3-Enterprise', encryption: 'GCMP' }, 'enterprise'],
    [{ auth: 'WPA-Personal', encryption: 'TKIP' }, 'unknown'], // legacy WPA1
    [{ auth: 'Open', encryption: 'WEP' }, 'unknown'],          // WEP is not our open path
    [{ auth: 'Shared', encryption: 'WEP' }, 'unknown'],
    [{ auth: 'gibberish', encryption: 'gibberish' }, 'unknown'],
    [{}, 'unknown'],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${expected}`, () => {
      expect(classifyWifiSecurity(input)).toBe(expected);
    });
  }

  it('WPA3-only is never confused with a WPA2-compatible transition', () => {
    // Only WPA3 present -> wpa3-only (rejected). WPA2 present anywhere -> joinable.
    expect(classifyWifiSecurity({ auth: 'WPA3-Personal' })).toBe('wpa3-only');
    expect(classifyWifiSecurity({ auth: 'WPA3-Personal, WPA2-Personal' })).toBe('wpa2-wpa3-transition');
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

  // --- audit M2: fields must never merge across adapter blocks ---

  const BOTH_CONNECTED = [
    {
      name: 'Wi-Fi',
      description: 'Intel(R) Wi-Fi 6 AX201 160MHz',
      connected: true,
      ssid: 'HOME',
      signalPct: 84,
    },
    {
      name: 'Wi-Fi 2',
      description: 'Ralink RT5370 USB Wireless Adapter',
      connected: true,
      ssid: 'W17-GRID',
      signalPct: 66,
    },
  ];

  it('two adapters on DIFFERENT networks: each block keeps its own ssid + signal pairing', () => {
    expect(parseNetshInterfacesList(fixture('netsh_interfaces_two_both_en.txt')))
      .toEqual(BOTH_CONNECTED);
  });

  it('reversed block order yields the SAME per-adapter objects (order affects nothing but sequence)', () => {
    const reversed = parseNetshInterfacesList(fixture('netsh_interfaces_two_both_reversed_en.txt'));
    expect(reversed).toEqual([BOTH_CONNECTED[1], BOTH_CONNECTED[0]]);
    // Same adapters by name, regardless of which block netsh printed first.
    const byName = Object.fromEntries(reversed.map((i) => [i.name, i]));
    expect(byName['Wi-Fi']).toEqual(BOTH_CONNECTED[0]);
    expect(byName['Wi-Fi 2']).toEqual(BOTH_CONNECTED[1]);
  });

  it('German fixture parses identically by structure (labels never matched, names carry spaces)', () => {
    const ifaces = parseNetshInterfacesList(fixture('netsh_interfaces_two_de.txt'));
    expect(ifaces).toEqual([
      { ...BOTH_CONNECTED[0], name: 'Drahtlosnetzwerk' },
      { ...BOTH_CONNECTED[1], name: 'Drahtlosnetzwerk 2' },
    ]);
  });

  it('a transitional adapter block (authenticating, no SSID yet) reads as not connected', () => {
    const ifaces = parseNetshInterfacesList(fixture('netsh_interfaces_dongle_connecting_en.txt'));
    expect(ifaces.map((i) => [i.name, i.connected])).toEqual([
      ['Wi-Fi', true],
      ['Wi-Fi 2', false],
    ]);
    expect(ifaces[1].ssid).toBe('');
    expect(ifaces[1].signalPct).toBeNull();
  });

  it('interface names with several spaces survive as one name string', () => {
    const out = [
      'There is 1 interface on the system:',
      '',
      '    Name                   : Wireless Network Connection 2',
      '    Description            : Ralink RT5370 USB Wireless Adapter',
      '    GUID                   : 87654321-4321-4321-4321-cba987654321',
      '    Physical address       : 11:22:33:44:55:66',
      '    State                  : connected',
      '    SSID                   : W17-GRID',
      '    Signal                 : 66%',
    ].join('\n');
    expect(parseNetshInterfacesList(out)).toEqual([{
      name: 'Wireless Network Connection 2',
      description: 'Ralink RT5370 USB Wireless Adapter',
      connected: true,
      ssid: 'W17-GRID',
      signalPct: 66,
    }]);
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

  it('carries non-ASCII SSID and password verbatim (no mangling)', () => {
    const xml = buildWlanProfileXml('Café Münchën 日本', 'pÿ-passwörd-Ω');
    expect(xml).toContain('<name>Café Münchën 日本</name>');
    expect(xml).toContain('<keyMaterial>pÿ-passwörd-Ω</keyMaterial>');
  });
});

describe('buildOpenWlanProfileXml — open-auth profile, no key (audit B3)', () => {
  it('declares authentication=open, encryption=none, and NO sharedKey', () => {
    const xml = buildOpenWlanProfileXml('Cafe Guest 2.4');
    expect(xml).toContain('<name>Cafe Guest 2.4</name>');
    expect(xml).toContain('<authentication>open</authentication>');
    expect(xml).toContain('<encryption>none</encryption>');
    expect(xml).not.toContain('sharedKey');    // an open network has no key
    expect(xml).not.toContain('keyMaterial');
  });

  it('escapes XML metacharacters and keeps non-ASCII SSIDs (injection-proof)', () => {
    const xml = buildOpenWlanProfileXml('Guest & "Café" <1> 日本');
    expect(xml).toContain('Guest &amp; &quot;Café&quot; &lt;1&gt; 日本');
    expect(xml.match(/&(?!amp;|quot;|apos;|lt;|gt;)/)).toBeNull();
    expect(xml).not.toContain('Guest & "Café"');
  });
});
