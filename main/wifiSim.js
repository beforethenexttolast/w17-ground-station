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
    builtin: { name: 'Wi-Fi', description: 'Intel(R) Wi-Fi 6 AX201 160MHz' },
    dongle: { name: 'Wi-Fi 2', description: 'Ralink RT5370 USB Wireless Adapter' },
};

function ifaceBlock({ name, description }, ssid) {
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
            '    Signal                 : 90%',
            `    Profile                : ${ssid}`,
        ]
        : [
            '    State                  : disconnected',
            '    Radio status           : Hardware On',
            '                             Software On',
        ];
    return [...head, ...tail].join('\n');
}

// The first adapter carries the joined SSID (netsh reports per-adapter; the
// sim keeps one connection like a single-radio machine).
function interfacesText(adapters, joinedSsid) {
    if (adapters.length === 0) return 'There is no wireless interface on the system.\n';
    const blocks = adapters.map((a, i) => ifaceBlock(a, i === 0 ? joinedSsid : null));
    return `There are ${adapters.length} interfaces on the system:\n\n${blocks.join('\n\n')}\n\n    Hosted network status  : Not available\n`;
}

const NETWORKS_TEXT = `Interface name : Wi-Fi
There are 2 networks currently visible.

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
// Stateful: `wlan connect name=X` makes later `show interfaces` report X as
// the connected SSID, so the managers' join poll loop behaves realistically.
function createSimRun(scenario, log = () => {}) {
    const netshFails = scenario === 'netsh-fail';
    const adapters = scenario === 'two-adapters' ? [ADAPTERS.builtin, ADAPTERS.dongle]
        : scenario === 'one-adapter' ? [ADAPTERS.builtin]
        : [];
    let joinedSsid = adapters.length > 0 ? 'PaddockNet' : null;
    log(`[wifisim] SIMULATED WIFI active (scenario: ${scenario}) — dev preview only, not bench evidence`);

    return async (cmd, args = []) => {
        if (cmd === 'powershell') {
            const script = args.join(' ');
            if (netshFails || adapters.length === 0) return fail('NO_PROFILE');
            if (script.includes('StartTethering')) return ok('START_Success\n');
            if (script.includes('StopTethering')) return ok('STOP_Success\n');
            return ok('TETHER_OK\n');
        }
        if (cmd !== 'netsh') return fail(`sim: unrouted command ${cmd}`);
        if (netshFails) return fail(NETSH_FAIL_TEXT);

        const key = args.slice(0, 3).join(' ');
        if (key.startsWith('wlan show interfaces')) return ok(interfacesText(adapters, joinedSsid));
        if (key.startsWith('wlan show networks')) {
            return adapters.length > 0 ? ok(NETWORKS_TEXT) : fail('There is no wireless interface on the system.');
        }
        if (key.startsWith('wlan show profiles')) return ok(PROFILES_TEXT);
        if (key.startsWith('wlan show drivers')) {
            return adapters.length > 0 ? ok(DRIVERS_TEXT) : fail('There is no wireless interface on the system.');
        }
        if (key.startsWith('wlan connect')) {
            if (adapters.length === 0) return fail('There is no wireless interface on the system.');
            const name = args.find((a) => a.startsWith('name='));
            joinedSsid = name ? name.slice('name='.length) : joinedSsid;
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
