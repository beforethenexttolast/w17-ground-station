import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// Audit D4 — command-generation and invocation hardening. A consolidated,
// cross-cutting proof that every external command this app builds is safe:
// executable + argv separation (never a shell string), no injection, correct
// XML escaping, credential redaction, temp-file containment + cleanup, and
// stable result shapes for the error paths. Per-module behavior lives in
// test/wifiManager, test/hotspot, test/hostProbe, test/runCommand, test/
// elrsLauncher; this file adds the gaps and the invariants that span files.

const require = createRequire(import.meta.url);
const { runCommand, winTreeKillArgs } = require('../main/runCommand.js');
const { WifiManager } = require('../main/wifiManager.js');
const {
  xmlEscape, buildWlanProfileXml, buildOpenWlanProfileXml,
} = require('../shared/wifiParse.js');

const node = process.execPath;

// ---------------------------------------------------------------------------
// 1. No shell, ever — argv separation is the whole injection defense.
// ---------------------------------------------------------------------------

describe('D4 — shell:false invariant (argv separation)', () => {
  it('runCommand declares shell:false and no command site opts into a shell', () => {
    const rc = readFileSync(new URL('../main/runCommand.js', import.meta.url), 'utf8');
    expect(rc).toContain('shell: false');
    // Scan every command-executing source file: none may enable a shell (which
    // would turn argv back into an injectable string). Covers a FUTURE new
    // consumer too, since it walks the dirs rather than a fixed list.
    const roots = ['../main', '../scripts'];
    const offenders = [];
    for (const root of roots) {
      const dir = new URL(`${root}/`, import.meta.url);
      for (const name of readdirSync(dir)) {
        if (!/\.(c?js)$/.test(name)) continue;
        const src = readFileSync(new URL(name, dir), 'utf8');
        if (/shell\s*:\s*true/.test(src)) offenders.push(`${root}/${name}`);
      }
    }
    expect(offenders, `shell:true found in: ${offenders.join(', ')}`).toEqual([]);
  });

  it('runCommand passes argv literally — shell metacharacters are inert (no split, no expansion, no substitution)', async () => {
    const evil = ['a b c', 'x; rm -rf y', '$(whoami)', '`id`', '&& echo pwned', '<in>', '"quoted"', "it's"];
    // With `node -e`, process.argv is [execPath, ...trailingArgs] (no script
    // path), so the passed args start at index 1.
    const res = await runCommand(node, [
      '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...evil,
    ]);
    expect(res.ok).toBe(true);
    // Each string arrived as ONE untouched argv element: nothing was word-split
    // on the space, nothing expanded `$()`/backticks, nothing acted on ; && < >.
    expect(JSON.parse(res.stdout)).toEqual(evil);
  });
});

// ---------------------------------------------------------------------------
// 2. Timeout tree-kill argv (audit N4).
// ---------------------------------------------------------------------------

describe('D4 — taskkill tree-termination argv (audit N4)', () => {
  it('builds `/pid <pid> /t /f` — /t takes the whole tree, /f forces it', () => {
    expect(winTreeKillArgs(4242)).toEqual(['/pid', '4242', '/t', '/f']);
    expect(winTreeKillArgs('4242')).toEqual(['/pid', '4242', '/t', '/f']); // pid stringified
    // /t (tree) is the point — a lone kill would orphan WinRT children.
    expect(winTreeKillArgs(1)).toContain('/t');
  });

  it('a wrapper timeout still returns the stable {ok:false, code:null, timeout} shape', async () => {
    const res = await runCommand(node, ['-e', 'setTimeout(()=>{}, 10000)'], { timeoutMs: 150 });
    expect(res).toMatchObject({ ok: false, code: null });
    expect(res.stderr).toMatch(/timeout after 150ms/);
  });

  it('a missing executable resolves ok:false (never throws) with a stable shape', async () => {
    const res = await runCommand('w17-no-such-binary-xyz', ['whatever']);
    expect(res).toMatchObject({ ok: false, code: null });
    expect(res.stderr.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. XML escaping for netsh WLAN profiles.
// ---------------------------------------------------------------------------

describe('D4 — WLAN profile XML escaping', () => {
  it('xmlEscape neutralizes all five XML metacharacters', () => {
    expect(xmlEscape(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
    // A crafted SSID cannot break out of an element or inject an attribute/tag.
    expect(xmlEscape('</name><evil>')).toBe('&lt;/name&gt;&lt;evil&gt;');
  });

  it('non-ASCII is preserved verbatim (only the five metacharacters change)', () => {
    expect(xmlEscape('Câfé Ünïçødé 車 📶')).toBe('Câfé Ünïçødé 車 📶');
  });

  it('a WPA2 profile escapes an XML-special SSID and passphrase, and only there', () => {
    const xml = buildWlanProfileXml(`A&B<C>"D'E`, `p&ss<w>"'d`);
    expect(xml).toContain(`<name>A&amp;B&lt;C&gt;&quot;D&apos;E</name>`);
    expect(xml).toContain(`<keyMaterial>p&amp;ss&lt;w&gt;&quot;&apos;d</keyMaterial>`);
    // No raw unescaped angle bracket from the user data survived into the doc.
    expect(xml).not.toContain('<C>');
    expect(xml).not.toContain('<w>');
  });

  it('an OPEN profile carries NO key material and still escapes the SSID', () => {
    const xml = buildOpenWlanProfileXml(`Guest & <Cafe>`);
    expect(xml).toContain('<name>Guest &amp; &lt;Cafe&gt;</name>');
    expect(xml).toContain('<authentication>open</authentication>');
    expect(xml).toContain('<encryption>none</encryption>');
    expect(xml).not.toContain('keyMaterial'); // nothing to leak
    expect(xml).not.toContain('sharedKey');
  });
});

// ---------------------------------------------------------------------------
// 4. wifiManager.join — command generation across the tricky inputs, plus
//    temp-file containment and cleanup on every exit.
// ---------------------------------------------------------------------------

// Fake command runner: routes on the netsh subcommand, records every call.
function fakeRun(routes) {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const key = args.slice(0, 3).join(' ');
    for (const [prefix, handler] of Object.entries(routes)) {
      if (key.startsWith(prefix)) {
        return typeof handler === 'function' ? handler({ cmd, args, opts, calls }) : handler;
      }
    }
    return { ok: false, code: 1, stdout: '', stderr: `unrouted: ${cmd} ${args.join(' ')}` };
  };
  return { run, calls };
}

const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' });
const fail = (stderr = 'boom') => ({ ok: false, code: 1, stdout: '', stderr });

const ifaceBlock = ({ name, ssid = null, signalPct = 90 }) => [
  `    Name                   : ${name}`,
  '    Description            : Test WLAN Adapter',
  '    GUID                   : 12345678-1234-1234-1234-123456789abc',
  '    Physical address       : aa:bb:cc:dd:ee:ff',
  ...(ssid
    ? ['    State                  : connected', `    SSID                   : ${ssid}`, `    Signal                 : ${signalPct}%`]
    : ['    State                  : disconnected']),
].join('\n');
const interfacesText = (...blocks) =>
  `There are ${blocks.length} interfaces on the system:\n\n${blocks.join('\n\n')}\n`;

// The join loop's 20s deadline uses Date.now(); fake the clock so timeout paths
// run instantly and the injected sleep advances it.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1_000_000); });
afterEach(() => { vi.useRealTimers(); });
const fakeSleep = async (ms) => { vi.setSystemTime(Date.now() + ms); };

function manager(routes, platform = 'win32') {
  const { run, calls } = fakeRun(routes);
  const tmpDir = mkdtempSync(join(tmpdir(), 'w17-cmdgen-'));
  const wifi = new WifiManager({ tmpDir, run, platform, sleep: fakeSleep });
  return { wifi, calls, tmpDir };
}

// Any leftover per-join temp directory under the injected tmpDir.
const leftoverProfileDirs = (tmpDir) => readdirSync(tmpDir).filter((n) => n.startsWith('w17-wlan-'));

describe('D4 — wifiManager.join command generation', () => {
  it('a non-ASCII SSID + passphrase survive verbatim into the profile XML and the connect argv', async () => {
    const ssid = 'Câfé Ünïçødé 車';
    const password = 'wpä2-café!';
    let xml = null;
    const { wifi, calls, tmpDir } = manager({
      'wlan add profile': ({ args }) => {
        xml = readFileSync(args.find((a) => a.startsWith('filename=')).slice('filename='.length), 'utf8');
        return ok('added');
      },
      [`wlan connect name=${ssid}`]: ok(),
      'wlan show interfaces': ok(interfacesText(ifaceBlock({ name: 'Wi-Fi', ssid }))),
    });
    expect(await wifi.join({ ssid, password, security: 'wpa2-personal', known: false })).toEqual({ ok: true });
    // No mojibake: the multibyte SSID/key round-trip through the utf8 temp file.
    expect(xml).toContain(`<name>${ssid}</name>`);
    expect(xml).toContain(`<keyMaterial>${password}</keyMaterial>`);
    // The SSID reaches netsh as ONE argv element (spaces intact), never a shell string.
    const connect = calls.find((c) => c.args.includes('connect'));
    expect(connect.args).toContain(`name=${ssid}`);
    expect(leftoverProfileDirs(tmpDir)).toEqual([]); // temp dir removed on success
  });

  it('an XML-special SSID is escaped in the profile but passed raw (and safe) in the connect argv', async () => {
    const ssid = `A&B<C>"D'E`;
    let xml = null;
    const { wifi, calls, tmpDir } = manager({
      'wlan add profile': ({ args }) => {
        xml = readFileSync(args.find((a) => a.startsWith('filename=')).slice('filename='.length), 'utf8');
        return ok();
      },
      [`wlan connect name=${ssid}`]: ok(),
      'wlan show interfaces': ok(interfacesText(ifaceBlock({ name: 'Wi-Fi', ssid }))),
    });
    expect(await wifi.join({ ssid, password: 'password1', security: 'wpa2-personal', known: false })).toEqual({ ok: true });
    expect(xml).toContain('<name>A&amp;B&lt;C&gt;&quot;D&apos;E</name>'); // escaped in XML
    expect(xml).not.toContain('<C>');                                     // no raw breakout
    // Raw in argv is fine because there is no shell: it is a single element.
    expect(calls.find((c) => c.args.includes('connect')).args).toContain(`name=${ssid}`);
    expect(leftoverProfileDirs(tmpDir)).toEqual([]);
  });

  it('a spaced SSID and a spaced adapter name each stay a single argv element', async () => {
    const { wifi, calls } = manager({
      'wlan add profile': ok(),
      'wlan connect name=Cafe Guest 2.4': ok(),
      'wlan show interfaces': ok(interfacesText(ifaceBlock({ name: 'Wi-Fi 2', ssid: 'Cafe Guest 2.4' }))),
    });
    expect(await wifi.join({ ssid: 'Cafe Guest 2.4', security: 'open', known: false, iface: 'Wi-Fi 2' })).toEqual({ ok: true });
    // The spaced SSID and the spaced adapter name are each ONE argv element —
    // never word-split into 'name=Cafe' + 'Guest' the way a shell string would.
    const connect = calls.find((c) => c.args.includes('connect'));
    expect(connect.args).toContain('name=Cafe Guest 2.4');
    expect(connect.args).toContain('interface=Wi-Fi 2');
    expect(connect.args).not.toContain('name=Cafe'); // proof it was not split
  });

  it('the key-bearing temp file lives in a PRIVATE per-join dir and is removed after a SUCCESSFUL join', async () => {
    let seen = null;
    const { wifi, tmpDir } = manager({
      'wlan add profile': ({ args }) => {
        const p = args.find((a) => a.startsWith('filename=')).slice('filename='.length);
        seen = { path: p, existedDuringAdd: existsSync(p) };
        // The profile sits inside a dedicated mkdtemp dir, not loose in tmpDir.
        expect(p).toMatch(/w17-wlan-[^/\\]+[/\\]profile\.xml$/);
        return ok();
      },
      'wlan connect name=Home': ok(),
      'wlan show interfaces': ok(interfacesText(ifaceBlock({ name: 'Wi-Fi', ssid: 'Home' }))),
    });
    expect((await wifi.join({ ssid: 'Home', password: 'password1', security: 'wpa2-personal', known: false })).ok).toBe(true);
    expect(seen.existedDuringAdd).toBe(true);
    expect(existsSync(seen.path)).toBe(false);     // file gone
    expect(leftoverProfileDirs(tmpDir)).toEqual([]); // whole dir gone
  });

  it('the temp profile dir is removed when ADD PROFILE fails', async () => {
    const { wifi, tmpDir } = manager({ 'wlan add profile': fail('bad profile') });
    const res = await wifi.join({ ssid: 'Home', password: 'password1', security: 'wpa2-personal', known: false });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/add profile failed/);
    expect(leftoverProfileDirs(tmpDir)).toEqual([]); // cleaned up despite failure
  });

  it('the temp profile dir is removed when CONNECT fails (cleanup happens before connect)', async () => {
    const { wifi, tmpDir } = manager({
      'wlan add profile': ok(),
      'wlan connect name=Home': fail('no such profile'),
    });
    const res = await wifi.join({ ssid: 'Home', password: 'password1', security: 'wpa2-personal', known: false });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/connect failed/);
    expect(leftoverProfileDirs(tmpDir)).toEqual([]);
  });

  it('the passphrase never appears in argv, the returned error, or a leftover file', async () => {
    const secret = 'sup3r&secret<pw>';
    const { wifi, calls, tmpDir } = manager({ 'wlan add profile': fail('nope') });
    const res = await wifi.join({ ssid: 'Home', password: secret, security: 'wpa2-personal', known: false });
    expect(calls.flatMap((c) => c.args).some((a) => a.includes(secret))).toBe(false);
    expect(JSON.stringify(res)).not.toContain(secret);
    expect(leftoverProfileDirs(tmpDir)).toEqual([]);
  });

  it('an out-of-scope SSID/security is rejected BEFORE any process is launched (no temp file, no spawn)', async () => {
    const { wifi, calls, tmpDir } = manager({});
    for (const bad of [
      { ssid: '', security: 'open' },
      { ssid: '   ', security: 'open' },
      { ssid: 'X', security: 'wpa3-only', password: 'whatever1' },
      { ssid: 'X', security: 'enterprise' },
      { ssid: 'X', security: 'unknown', known: false, password: 'password1' },
    ]) {
      const res = await wifi.join(bad);
      expect(res.ok).toBe(false);
    }
    expect(calls).toHaveLength(0);              // never launched a process
    expect(leftoverProfileDirs(tmpDir)).toEqual([]); // never wrote a temp file
  });
});
