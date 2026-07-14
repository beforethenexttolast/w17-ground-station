// Dev-only PIT WALL simulation (`W17_WIFI_SIM`): a canned command runner that
// stands in for netsh/powershell so the WiFi + hotspot managers — and the REAL
// parsers in shared/wifiParse.js — run the whole network step on any OS with
// no hardware. main.js swaps it in at the managers' injectable `run` seam and
// forces platform 'win32'; with the env var unset nothing here is constructed
// and the app is byte-identical to the real path.
//
// PREVIEW ONLY: never valid as bench evidence (docs/setup_flow_bench_checklist.md
// requires the real OS layer, sim unset).

const SCENARIOS = ['two-adapters', 'one-adapter', 'no-adapter', 'netsh-fail'];
const DEFAULT_SCENARIO = 'two-adapters';

// env -> scenario name, or null when the sim is off (unset/empty). Any other
// non-empty value warns and falls back to the default so a typo still previews.
function simScenario(env = {}, warn = () => {}) {
    const raw = env.W17_WIFI_SIM;
    if (!raw) return null;
    if (SCENARIOS.includes(raw)) return raw;
    warn(`[wifisim] unknown W17_WIFI_SIM=${raw}; using ${DEFAULT_SCENARIO} (known: ${SCENARIOS.join(', ')})`);
    return DEFAULT_SCENARIO;
}

const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' });
const fail = (stderr) => ({ ok: false, code: 1, stdout: '', stderr });

const NETSH_FAIL_TEXT = 'The Wireless AutoConfig Service (wlansvc) is not running.';

// --- canned netsh text (mirrors the EN fixtures in test/fixtures/) ---------

const ADAPTERS = {
    builtin: { name: 'Wi-Fi', description: 'Intel(R) Wi-Fi 6 AX201 160MHz', signalPct: 90 },
    dongle: { name: 'Wi-Fi 2', description: 'Ralink RT5370 USB Wireless Adapter', signalPct: 72 },
};

function ifaceBlock({ name, description, signalPct }, ssid) {
    const head = [
        `    Name                   : ${name}`,
        `    Description            : ${description}`,
        '    GUID                   : 12345678-1234-1234-1234-123456789abc',
        '    Physical address       : aa:bb:cc:dd:ee:ff',
    ];
    const tail = ssid
        ? [
            '    State                  : connected',
            `    SSID                   : ${ssid}`,
            '    Network type           : Infrastructure',
            '    Authentication         : WPA2-Personal',
            `    Signal                 : ${signalPct}%`,
            `    Profile                : ${ssid}`,
        ]
        : [
            '    State                  : disconnected',
            '    Radio status           : Hardware On',
            '                             Software On',
        ];
    return [...head, ...tail].join('\n');
}

// netsh reports per-adapter, so the sim tracks the joined SSID PER ADAPTER
// (`joined` maps adapter name -> ssid): a join pinned to the RT5370 shows up
// on the RT5370's block while the built-in keeps its own network — the exact
// two-adapter topology the pinned status/join verification exists for.
function interfacesText(adapters, joined) {
    if (adapters.length === 0) return 'There is no wireless interface on the system.\n';
    const blocks = adapters.map((a) => ifaceBlock(a, joined.get(a.name) || null));
    return `There are ${adapters.length} interfaces on the system:\n\n${blocks.join('\n\n')}\n\n    Hosted network status  : Not available\n`;
}

// A spread of security kinds so the PIT WALL preview shows every B3 branch:
// a known WPA2 network, an OPEN one (warning, no password), a WPA3-only and an
// enterprise one (both rejected before any join), plus a hidden/empty-SSID
// block that must be skipped, never rendered as a clickable row.
const NETWORKS_TEXT = `Interface name : Wi-Fi
There are 5 networks currently visible.

SSID 1 : PaddockNet
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP

    BSSID 1                 : aa:bb:cc:11:22:33
         Signal             : 87%
         Radio type         : 802.11n
         Channel            : 6

SSID 2 : Cafe Guest 2.4
    Network type            : Infrastructure
    Authentication          : Open
    Encryption              : None

    BSSID 1                 : ff:ee:dd:55:66:77
         Signal             : 42%
         Radio type         : 802.11n
         Channel            : 11

SSID 3 : Paddock 6E
    Network type            : Infrastructure
    Authentication          : WPA3-Personal
    Encryption              : GCMP

    BSSID 1                 : ab:cd:ef:11:22:33
         Signal             : 70%
         Radio type         : 802.11ax
         Channel            : 36

SSID 4 : Team Corp
    Network type            : Infrastructure
    Authentication          : WPA2-Enterprise
    Encryption              : CCMP

    BSSID 1                 : ab:cd:ef:44:55:66
         Signal             : 55%
         Radio type         : 802.11ac
         Channel            : 44

SSID 5 :
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP

    BSSID 1                 : 99:88:77:66:55:44
         Signal             : 30%
         Radio type         : 802.11n
         Channel            : 1
`;

const PROFILES_TEXT = `Profiles on interface Wi-Fi:

Group policy profiles (read only)
---------------------------------
    <None>

User profiles
-------------
    All User Profile     : PaddockNet
    All User Profile     : W17-GRID
`;

const DRIVERS_TEXT = `Interface name: Wi-Fi

    Driver                    : Ralink RT5370 Wireless LAN Card
    Type                      : Native Wi-Fi Driver
    Hosted network supported  : Yes
`;

// --- the fake runner --------------------------------------------------------

// Returns an async run(cmd, args) compatible with main/runCommand.js results.
// Stateful: `wlan connect name=X [interface=Y]` makes later `show interfaces`
// report X as adapter Y's connected SSID (default: the first adapter), so the
// managers' PINNED join poll loop behaves realistically — joining W17-GRID on
// the dongle leaves the built-in adapter on its own network.
function createSimRun(scenario, log = () => {}) {
    const netshFails = scenario === 'netsh-fail';
    const adapters = scenario === 'two-adapters' ? [ADAPTERS.builtin, ADAPTERS.dongle]
        : scenario === 'one-adapter' ? [ADAPTERS.builtin]
        : [];
    const joined = new Map(adapters.length > 0 ? [[adapters[0].name, 'PaddockNet']] : []);
    log(`[wifisim] SIMULATED WIFI active (scenario: ${scenario}) — dev preview only, not bench evidence`);

    return async (cmd, args = []) => {
        if (cmd === 'powershell') {
            const script = args.join(' ');
            // The elevation FACT check (audit B2) is independent of WLAN
            // state: the sim always answers "elevated" so its deterministic
            // failures never smuggle in the administrator suggestion.
            if (script.includes('WindowsPrincipal')) return ok('ELEV_ADMIN\n');
            // The fail-closed WinRT prologue (main/hotspot.js) exits with
            // RESULT_NO_PROFILE (code 2) when there is no tetherable connection
            // profile — exactly the no-adapter / broken-WLAN case here.
            if (netshFails || adapters.length === 0) {
                return { ok: false, code: 2, stdout: 'RESULT_NO_PROFILE\n', stderr: '' };
            }
            if (script.includes('StartTetheringAsync')) return ok('START_OK\n');
            if (script.includes('StopTetheringAsync')) return ok('STOP_OK\n');
            return ok('PROBE_STATE_Off\nPROBE_OK\n');
        }
        if (cmd !== 'netsh') return fail(`sim: unrouted command ${cmd}`);
        if (netshFails) return fail(NETSH_FAIL_TEXT);

        const key = args.slice(0, 3).join(' ');
        if (key.startsWith('wlan show interfaces')) return ok(interfacesText(adapters, joined));
        if (key.startsWith('wlan show networks')) {
            return adapters.length > 0 ? ok(NETWORKS_TEXT) : fail('There is no wireless interface on the system.');
        }
        if (key.startsWith('wlan show profiles')) return ok(PROFILES_TEXT);
        if (key.startsWith('wlan show drivers')) {
            return adapters.length > 0 ? ok(DRIVERS_TEXT) : fail('There is no wireless interface on the system.');
        }
        if (key.startsWith('wlan connect')) {
            if (adapters.length === 0) return fail('There is no wireless interface on the system.');
            const ifaceArg = args.find((a) => a.startsWith('interface='));
            const target = ifaceArg
                ? adapters.find((a) => a.name === ifaceArg.slice('interface='.length))
                : adapters[0];
            if (!target) return fail('There is no wireless interface with the specified name.');
            const name = args.find((a) => a.startsWith('name='));
            if (name) joined.set(target.name, name.slice('name='.length));
            return ok('Connection request was completed successfully.\n');
        }
        if (key.startsWith('wlan add profile')) return ok('Profile is added on interface Wi-Fi.\n');
        if (key.startsWith('wlan set hostednetwork')) {
            return adapters.length > 0 ? ok('The hosted network mode has been set to allow.\n') : fail('There is no wireless interface on the system.');
        }
        if (key.startsWith('wlan start hostednetwork')) return ok('The hosted network started.\n');
        if (key.startsWith('wlan stop hostednetwork')) return ok('The hosted network stopped.\n');
        return fail(`sim: unrouted netsh ${args.join(' ')}`);
    };
}

module.exports = { SCENARIOS, simScenario, createSimRun };
